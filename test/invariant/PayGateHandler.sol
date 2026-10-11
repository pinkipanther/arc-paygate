// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {PayGate} from "../../src/PayGate.sol";
import {RevertingReceiver, PayingReceiver} from "../utils/Receivers.sol";

/// @notice Drives PayGate with a bounded set of actors and ids and keeps an independent model.
///         Every action predicts its outcome (success or the exact custom error) from the model
///         before calling, and records any divergence in a flag the invariants assert on.
///         Ghost totals are rebuilt from the emitted logs, so the invariants also check that
///         events alone reproduce on-chain accounting (what an indexer would do).
contract PayGateHandler is CommonBase, StdCheats, StdUtils {
    PayGate public immutable GATE;
    RevertingReceiver public immutable REVERTER;
    PayingReceiver public immutable PAYER;
    address public immutable SINK;

    uint256 public constant MAX_RESOURCES = 8;
    uint256 public constant N_EOA = 4;

    address[] internal _actors; // every address that can ever be a seller or beneficiary
    uint256 public time;

    struct Model {
        address seller;
        uint96 price;
        uint32 window;
        bool active;
        bytes32 uriHash;
    }

    mapping(uint256 => Model) internal _model;

    // ghosts rebuilt from logs
    mapping(uint256 => uint256) public ghostPaidSum;
    mapping(uint256 => uint256) public ghostPaidCount;
    uint256 public ghostDeposits;
    uint256 public ghostWithdrawals;
    // ghosts from call results (top-level pays + pays made inside a withdraw callback)
    uint256 public ghostSuccessfulPays;
    mapping(address => mapping(uint256 => uint64)) public lastSeenUntil;

    // violation flags (must stay false)
    bool public accessDecreased;
    bool public nonSellerChanged;
    bool public untilMismatch;
    bool public unexpectedOutcome;
    bool public payoutMismatch;
    string public lastViolation;

    // call statistics, keyed by action name
    bytes32 public constant K_CREATE = "create";
    bytes32 public constant K_UPDATE = "update";
    bytes32 public constant K_TRANSFER = "transfer";
    bytes32 public constant K_PAY = "pay";
    bytes32 public constant K_PAYFOR = "payFor";
    bytes32 public constant K_WITHDRAW = "withdraw";
    bytes32 public constant K_WITHDRAWTO = "withdrawTo";
    bytes32 public constant K_WARP = "warp";
    mapping(bytes32 => uint256) public calls;
    mapping(bytes4 => uint256) public revertsBySelector;
    mapping(bytes32 => uint256) public reverts;

    constructor(PayGate gate) {
        GATE = gate;
        REVERTER = new RevertingReceiver(gate);
        PAYER = new PayingReceiver(gate);
        SINK = makeAddr("sink");
        for (uint256 i; i < N_EOA; ++i) _actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        _actors.push(address(REVERTER));
        _actors.push(address(PAYER));
        time = block.timestamp;
    }

    // ------------------------------------------------------------------ views for invariants

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    function model(uint256 id) external view returns (Model memory) {
        return _model[id];
    }

    // ------------------------------------------------------------------ helpers

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    function _uri(uint256 len) internal pure returns (string memory) {
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) b[i] = bytes1(uint8(0x61 + (i % 26)));
        return string(b);
    }

    /// Price in whole micro-USDC up to 1 USDC; a quarter of resources are free.
    function _price(uint256 seed) internal view returns (uint96) {
        if (seed % 4 == 0) return 0;
        return uint96(bound(seed, 1, 1_000_000)) * uint96(GATE.PRICE_UNIT());
    }

    /// Mostly existing ids; 1/16 of seeds hit id 0 or the first unused id. The mapping keeps the
    /// fuzzer's favourite edge values (0, max) on live resources.
    function _id(uint256 seed) internal view returns (uint256) {
        uint256 n = GATE.nextId() - 1; // >= 2: setUp seeds two resources
        if (seed % 16 == 7) return (seed / 16) % 2 == 0 ? 0 : n + 1;
        return 1 + (seed / 16) % n;
    }

    /// Half the time, the first actor (from a seed-chosen start) that has something to withdraw.
    function _withdrawer(uint256 seed) internal view returns (address) {
        if (seed % 2 == 1) return _actor(seed / 2);
        for (uint256 i; i < _actors.length; ++i) {
            address a = _actors[(seed / 2 + i) % _actors.length];
            if (GATE.balances(a) > 0) return a;
        }
        return _actor(seed / 2);
    }

    function _flag(string memory why) internal {
        unexpectedOutcome = true;
        lastViolation = why;
    }

    function _begin(bytes32 name) internal {
        vm.warp(time);
        vm.recordLogs();
        calls[name]++;
    }

    /// Consume the logs of this action. Logs of a reverted top-level call are discarded.
    function _end(bool succeeded) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (succeeded) {
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter != address(GATE)) continue;
                bytes32 sig = logs[i].topics[0];
                if (sig == PayGate.Paid.selector) {
                    uint256 id = uint256(logs[i].topics[1]);
                    (uint256 amount,) = abi.decode(logs[i].data, (uint256, uint64));
                    ghostPaidSum[id] += amount;
                    ghostPaidCount[id] += 1;
                    ghostDeposits += amount;
                } else if (sig == PayGate.Withdrawn.selector) {
                    ghostWithdrawals += abi.decode(logs[i].data, (uint256));
                }
            }
        }
        _checkAccessMonotonic();
    }

    function _checkAccessMonotonic() internal {
        uint256 end = GATE.nextId() + 1;
        for (uint256 a; a < _actors.length; ++a) {
            for (uint256 id; id <= end; ++id) {
                uint64 u = GATE.accessUntil(_actors[a], id);
                if (u < lastSeenUntil[_actors[a]][id]) {
                    accessDecreased = true;
                    lastViolation = "accessUntil decreased";
                }
                lastSeenUntil[_actors[a]][id] = u;
            }
        }
    }

    /// Custom-error selector of revert data (truncation to the first 4 bytes is the point).
    function _sel(bytes memory err) internal returns (bytes4 sel) {
        // forge-lint: disable-next-line(unsafe-typecast)
        sel = bytes4(err);
        revertsBySelector[sel]++;
    }

    // ------------------------------------------------------------------ seller actions

    function create(uint256 actorSeed, uint256 priceSeed, uint32 window, uint8 uriLen) external {
        if (GATE.nextId() > MAX_RESOURCES) return;
        _begin(K_CREATE);
        address who = _actor(actorSeed);
        uint96 price = _price(priceSeed);
        window = uint32(bound(window, 1, 3 days));
        string memory uri = _uri(bound(uriLen, 0, 40));
        uint256 expectedId = GATE.nextId();

        vm.prank(who);
        try GATE.createResource(price, window, uri) returns (uint256 id) {
            if (id != expectedId) _flag("create: unexpected id");
            _model[id] =
                Model({seller: who, price: price, window: window, active: true, uriHash: keccak256(bytes(uri))});
            _end(true);
        } catch {
            reverts[K_CREATE]++;
            _flag("create: valid terms reverted");
            _end(false);
        }
    }

    /// `asSeller` picks the real seller half the time; otherwise a random actor, which must fail.
    /// `mode` occasionally submits invalid terms, which must fail with the matching error.
    function update(
        uint256 actorSeed,
        uint256 idSeed,
        bool asSeller,
        uint256 priceSeed,
        uint32 window,
        uint8 activeSeed,
        uint8 uriLen,
        uint8 mode
    ) external {
        _begin(K_UPDATE);
        uint256 id = _id(idSeed);
        Model memory m = _model[id];
        address who = asSeller && m.seller != address(0) ? m.seller : _actor(actorSeed);
        uint96 price = _price(priceSeed);
        window = uint32(bound(window, 1, 3 days));
        uint256 len = bound(uriLen, 0, 40);
        bool active = activeSeed % 5 != 4;
        mode = mode % 16; // 0..3 = invalid terms
        if (mode == 0) window = 0;
        else if (mode == 1) window = GATE.MAX_WINDOW() + 1;
        else if (mode == 2) price = uint96(GATE.PRICE_UNIT()) + 1;
        else if (mode == 3) len = GATE.MAX_URI() + 1;
        string memory uri = _uri(len);

        bytes4 expected;
        if (who != m.seller) expected = PayGate.NotSeller.selector;
        else if (mode == 2) expected = PayGate.PricePrecision.selector;
        else if (mode == 0) expected = PayGate.ZeroWindow.selector;
        else if (mode == 1) expected = PayGate.WindowTooLong.selector;
        else if (mode == 3) expected = PayGate.UriTooLong.selector;

        vm.prank(who);
        try GATE.updateResource(id, price, window, active, uri) {
            if (who != m.seller) {
                nonSellerChanged = true;
                lastViolation = "update by non-seller succeeded";
            }
            if (expected != bytes4(0)) _flag("update: invalid terms accepted");
            _model[id] =
                Model({seller: m.seller, price: price, window: window, active: active, uriHash: keccak256(bytes(uri))});
            _end(true);
        } catch (bytes memory err) {
            reverts[K_UPDATE]++;
            if (_sel(err) != expected || expected == bytes4(0)) _flag("update: wrong revert");
            _end(false);
        }
    }

    function transfer(uint256 actorSeed, uint256 idSeed, bool asSeller, uint256 toSeed) external {
        _begin(K_TRANSFER);
        uint256 id = _id(idSeed);
        Model memory m = _model[id];
        address who = asSeller && m.seller != address(0) ? m.seller : _actor(actorSeed);
        address to = toSeed % 8 == 0 ? address(0) : _actor(toSeed);

        bytes4 expected;
        if (who != m.seller) expected = PayGate.NotSeller.selector;
        else if (to == address(0)) expected = PayGate.ZeroAddress.selector;

        vm.prank(who);
        try GATE.transferResource(id, to) {
            if (who != m.seller) {
                nonSellerChanged = true;
                lastViolation = "transfer by non-seller succeeded";
            }
            if (expected != bytes4(0)) _flag("transfer: should have reverted");
            _model[id].seller = to;
            _end(true);
        } catch (bytes memory err) {
            reverts[K_TRANSFER]++;
            if (_sel(err) != expected || expected == bytes4(0)) _flag("transfer: wrong revert");
            _end(false);
        }
    }

    // ------------------------------------------------------------------ buyer actions

    /// `mode`: 1/8 sends the wrong amount, 1/8 asks for a random (possibly too long) minWindow,
    /// the rest pay the exact price with a satisfiable minWindow.
    function pay(uint256 actorSeed, uint256 idSeed, uint32 minWindow, uint8 mode) external {
        _begin(K_PAY);
        address who = _actor(actorSeed);
        _doPay(who, who, _id(idSeed), minWindow, mode, false);
    }

    /// 1/16 of calls name address(0) as beneficiary.
    function payFor(uint256 actorSeed, uint256 idSeed, uint256 benSeed, uint32 minWindow, uint8 mode) external {
        _begin(K_PAYFOR);
        address who = _actor(actorSeed);
        address ben = benSeed % 16 == 0 ? address(0) : _actor(benSeed);
        _doPay(who, ben, _id(idSeed), minWindow, mode, true);
    }

    /// Prediction for one payment, kept in storage to stay clear of stack limits.
    struct PayCtx {
        address who;
        address ben;
        uint256 id;
        uint32 minWindow;
        uint256 value;
        bool viaFor;
        address seller;
        bytes4 expected;
        uint64 want;
        uint256 sellerBefore;
    }

    PayCtx internal _p;

    function _doPay(address who, address ben, uint256 id, uint32 minWindow, uint8 mode, bool viaFor) internal {
        Model memory m = _model[id];
        PayCtx storage c = _p;
        c.who = who;
        c.ben = ben;
        c.id = id;
        mode = mode % 8;
        c.minWindow = mode == 1 ? uint32(bound(minWindow, 0, 3 days + 1)) : uint32(minWindow % (uint256(m.window) + 1));
        c.value = mode == 0 ? uint256(m.price) + GATE.PRICE_UNIT() : m.price;
        c.viaFor = viaFor;
        c.seller = m.seller;
        c.sellerBefore = GATE.balances(m.seller);

        if (viaFor && ben == address(0)) c.expected = PayGate.ZeroAddress.selector;
        else if (!m.active) c.expected = PayGate.Inactive.selector; // also never-created ids
        else if (c.value != m.price) c.expected = PayGate.WrongAmount.selector;
        else if (m.window < c.minWindow) c.expected = PayGate.WindowTooShort.selector;
        else c.expected = bytes4(0);

        // Model: paid access stacks on max(now, prev); free claims refresh to max(prev, now + w).
        uint64 prev = GATE.accessUntil(ben, id);
        uint64 start = uint64(block.timestamp);
        if (m.price == 0) c.want = start + m.window > prev ? start + m.window : prev;
        else c.want = (prev > start ? prev : start) + m.window;

        vm.deal(who, who.balance + c.value);
        (bool ok, uint64 until, bytes memory err) = _execPay();
        _checkPay(ok, until, err);
    }

    function _execPay() internal returns (bool ok, uint64 until, bytes memory err) {
        PayCtx memory c = _p;
        // vm.prank makes `who` both msg.sender and the source of the value.
        vm.prank(c.who);
        if (c.viaFor) {
            try GATE.payFor{value: c.value}(c.id, c.ben, c.minWindow) returns (uint64 u) {
                (ok, until) = (true, u);
            } catch (bytes memory e) {
                err = e;
            }
        } else {
            try GATE.pay{value: c.value}(c.id, c.minWindow) returns (uint64 u) {
                (ok, until) = (true, u);
            } catch (bytes memory e) {
                err = e;
            }
        }
    }

    function _checkPay(bool ok, uint64 until, bytes memory err) internal {
        PayCtx memory c = _p;
        if (ok) {
            ghostSuccessfulPays++;
            if (c.expected != bytes4(0)) _flag("pay: should have reverted");
            if (until != c.want || GATE.accessUntil(c.ben, c.id) != c.want) {
                untilMismatch = true;
                lastViolation = "pay: expiry differs from model";
            }
            if (GATE.balances(c.seller) != c.sellerBefore + c.value) {
                payoutMismatch = true;
                lastViolation = "pay: seller not credited exactly";
            }
        } else {
            reverts[c.viaFor ? K_PAYFOR : K_PAY]++;
            if (_sel(err) != c.expected || c.expected == bytes4(0)) _flag("pay: wrong revert");
        }
        _end(ok);
    }

    // ------------------------------------------------------------------ withdrawals

    function withdraw(uint256 actorSeed, uint256 armSeed, bool arm) external {
        _begin(K_WITHDRAW);
        address who = _withdrawer(actorSeed);
        _armPayer(armSeed, arm);
        _doWithdraw(who, payable(who), false);
    }

    /// Recipients: the sink, any actor, the reverting receiver, the gate itself, or address(0).
    function withdrawTo(uint256 actorSeed, uint256 toSeed, uint256 armSeed, bool arm) external {
        _begin(K_WITHDRAWTO);
        address who = _withdrawer(actorSeed);
        _armPayer(armSeed, arm);
        uint256 k = toSeed % 9;
        address to = k < 6 ? _actors[k] : k == 6 ? SINK : k == 7 ? address(GATE) : address(0);
        _doWithdraw(who, payable(to), true);
    }

    function _armPayer(uint256 seed, bool arm) internal {
        if (arm) PAYER.arm(_id(seed));
        else PAYER.disarm();
    }

    function _doWithdraw(address who, address payable to, bool viaTo) internal {
        uint256 bal = GATE.balances(who);
        bytes4 expected;
        if (viaTo && to == address(0)) expected = PayGate.ZeroAddress.selector;
        else if (bal == 0) expected = PayGate.NothingToWithdraw.selector;
        else if (to == address(REVERTER) || to == address(GATE)) expected = PayGate.TransferFailed.selector;

        uint256 toBefore = to.balance;
        uint256 nestedBefore = PAYER.nestedPays();
        vm.prank(who);
        if (viaTo) {
            try GATE.withdrawTo(to) {
                _afterWithdraw(expected, to, toBefore, bal, nestedBefore);
            } catch (bytes memory err) {
                _withdrawReverted(K_WITHDRAWTO, err, expected);
            }
        } else {
            try GATE.withdraw() {
                _afterWithdraw(expected, to, toBefore, bal, nestedBefore);
            } catch (bytes memory err) {
                _withdrawReverted(K_WITHDRAW, err, expected);
            }
        }
    }

    function _afterWithdraw(bytes4 expected, address to, uint256 toBefore, uint256 bal, uint256 nestedBefore)
        internal
    {
        if (expected != bytes4(0)) _flag("withdraw: should have reverted");
        // The paying receiver may spend part of what it received inside its hook.
        if (to != address(PAYER) && to.balance != toBefore + bal) {
            payoutMismatch = true;
            lastViolation = "withdraw: recipient not paid exactly";
        }
        ghostSuccessfulPays += PAYER.nestedPays() - nestedBefore; // pays made from the hook
        _end(true);
    }

    function _withdrawReverted(bytes32 name, bytes memory err, bytes4 expected) internal {
        reverts[name]++;
        if (_sel(err) != expected || expected == bytes4(0)) _flag("withdraw: wrong revert");
        _end(false);
    }

    // ------------------------------------------------------------------ time

    function warp(uint32 dt) external {
        time += bound(dt, 0, 2 days);
        _begin(K_WARP);
        _end(true);
    }
}
