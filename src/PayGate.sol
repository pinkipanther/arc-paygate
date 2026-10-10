// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PayGate — pay-per-access paywall settled in Arc's native USDC
/// @notice Sellers register resources with a USDC price and an access window.
///         Buyers (humans or AI agents) pay with a plain value transfer — no ERC-20
///         approve step, because on Arc the gas token *is* USDC. An off-chain server
///         answers HTTP 402 with the resource id and price, then checks `hasAccess`.
/// @dev    Native USDC on Arc uses 18 decimals for `msg.value` (1 USDC = 1e18 wei).
///         No owner, no upgradeability, no external calls except the seller's own `withdraw`.
contract PayGate {
    struct Resource {
        address seller;      // receives payments (pull pattern)
        uint96  price;       // in native wei (18-dec USDC); fits 7.9e10 USDC
        uint32  window;      // seconds of access granted per payment (max ~136 years)
        bool    active;
        string  uri;         // where the resource is served (informational)
    }

    uint256 public nextId = 1;
    mapping(uint256 => Resource) public resources;
    /// @dev buyer => resourceId => unix timestamp until which access is valid (inclusive)
    mapping(address => mapping(uint256 => uint64)) public accessUntil;
    mapping(address => uint256) public balances;

    event ResourceCreated(uint256 indexed id, address indexed seller, uint96 price, uint32 window, string uri);
    event ResourceUpdated(uint256 indexed id, uint96 price, uint32 window, bool active, string uri);
    event Paid(uint256 indexed id, address indexed payer, address indexed beneficiary, uint256 amount, uint64 until);
    event Withdrawn(address indexed seller, uint256 amount);

    error NotSeller();
    error Inactive();
    error WrongAmount(uint256 expected, uint256 got);
    error WindowTooShort(uint32 minWindow, uint32 actual);
    error ZeroWindow();
    error ZeroBeneficiary();
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlySeller(uint256 id) {
        _checkSeller(id);
        _;
    }

    function _checkSeller(uint256 id) internal view {
        if (resources[id].seller != msg.sender) revert NotSeller();
    }

    /// @notice Register a resource. `price` may be 0 (free, still records access).
    function createResource(uint96 price, uint32 window, string calldata uri) external returns (uint256 id) {
        if (window == 0) revert ZeroWindow();
        id = nextId++;
        resources[id] = Resource({seller: msg.sender, price: price, window: window, active: true, uri: uri});
        emit ResourceCreated(id, msg.sender, price, window, uri);
    }

    /// @notice Reprice, resize the window, pause/unpause, or change the uri.
    /// @dev    Already-granted access is never revoked: `hasAccess` ignores `active`.
    function updateResource(uint256 id, uint96 price, uint32 window, bool active, string calldata uri)
        external
        onlySeller(id)
    {
        if (window == 0) revert ZeroWindow();
        Resource storage r = resources[id];
        r.price = price;
        r.window = window;
        r.active = active;
        r.uri = uri;
        emit ResourceUpdated(id, price, window, active, uri);
    }

    /// @notice Pay for your own access.
    /// @param minWindow Revert unless the resource still grants at least this many seconds
    ///        (slippage guard: the seller cannot shrink the window between quote and pay).
    ///        The exact-amount check already guards the price. Pass 0 to accept any window.
    function pay(uint256 id, uint32 minWindow) external payable returns (uint64 until) {
        return _pay(id, msg.sender, minWindow);
    }

    /// @notice Pay on behalf of another address (e.g. an operator funding its agent's key).
    function payFor(uint256 id, address beneficiary, uint32 minWindow) external payable returns (uint64 until) {
        return _pay(id, beneficiary, minWindow);
    }

    function _pay(uint256 id, address beneficiary, uint32 minWindow) internal returns (uint64 until) {
        if (beneficiary == address(0)) revert ZeroBeneficiary();
        Resource storage r = resources[id];
        if (!r.active) revert Inactive();
        if (msg.value != r.price) revert WrongAmount(r.price, msg.value);
        if (r.window < minWindow) revert WindowTooShort(minWindow, r.window);

        // Extend from the later of now / existing expiry so prepaying stacks windows.
        // uint64 + uint32 is checked arithmetic; overflow would need ~4e9 stacked payments.
        uint64 base = accessUntil[beneficiary][id];
        if (base < block.timestamp) base = uint64(block.timestamp);
        until = base + r.window;
        accessUntil[beneficiary][id] = until;

        if (msg.value > 0) balances[r.seller] += msg.value;
        emit Paid(id, msg.sender, beneficiary, msg.value, until);
    }

    function hasAccess(address who, uint256 id) external view returns (bool) {
        return accessUntil[who][id] >= block.timestamp;
    }

    /// @notice Sellers pull their accumulated USDC. Checks-effects-interactions; a re-entrant
    ///         `withdraw` from the seller's receive hook sees a zero balance and reverts.
    function withdraw() external {
        uint256 amt = balances[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amt);
    }

    /// @notice Quote for a 402 response: price (wei), window, seller, active, uri.
    function quote(uint256 id)
        external
        view
        returns (uint96 price, uint32 window, address seller, bool active, string memory uri)
    {
        Resource storage r = resources[id];
        return (r.price, r.window, r.seller, r.active, r.uri);
    }
}
