// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PayGate — pay-per-access paywall settled in Arc's native USDC
/// @notice Sellers register resources with a USDC price and an access window.
///         Buyers (humans or AI agents) pay with a plain value transfer — no ERC-20
///         approve step, because on Arc the gas token *is* USDC. An off-chain server
///         answers HTTP 402 with the resource id and price, then checks `hasAccess`.
/// @dev    Native USDC on Arc uses 18 decimals for `msg.value` (1 USDC = 1e18 wei).
///         No owner, no upgradeability, no fees, no external calls except withdrawals.
contract PayGate {
    /// @dev Slot 0: seller (20) + price (12). Slot 1: window (4) + active (1) + sales (8) + revenue (16).
    ///      `_pay` reads slot 1 anyway, so updating the stats costs one warm SSTORE.
    struct Resource {
        address seller;   // receives payments (pull pattern)
        uint96 price;     // native wei (18-dec USDC); max ~7.9e10 USDC
        uint32 window;    // seconds of access granted per payment (max ~136 years)
        bool active;      // new sales allowed
        uint64 sales;     // number of successful payments
        uint128 revenue;  // lifetime wei received for this resource
        string uri;       // where the resource is served (informational, <= MAX_URI bytes)
    }

    /// @notice Read model for frontends and indexers.
    struct ResourceView {
        uint256 id;
        address seller;
        uint96 price;
        uint32 window;
        bool active;
        uint64 sales;
        uint128 revenue;
        string uri;
    }

    uint256 public constant MAX_URI = 512;
    uint256 public constant MAX_PAGE = 100;

    uint256 public nextId = 1;
    mapping(uint256 => Resource) internal _resources;
    /// @notice buyer => resourceId => unix timestamp at which access ends (exclusive).
    mapping(address => mapping(uint256 => uint64)) public accessUntil;
    /// @notice seller => withdrawable wei.
    mapping(address => uint256) public balances;

    event ResourceCreated(uint256 indexed id, address indexed seller, uint96 price, uint32 window, string uri);
    event ResourceUpdated(uint256 indexed id, uint96 price, uint32 window, bool active, string uri);
    event ResourceTransferred(uint256 indexed id, address indexed from, address indexed to);
    event Paid(uint256 indexed id, address indexed payer, address indexed beneficiary, uint256 amount, uint64 until);
    event Withdrawn(address indexed seller, address indexed to, uint256 amount);

    error NotSeller();
    error Inactive();
    error WrongAmount(uint256 expected, uint256 got);
    error WindowTooShort(uint32 minWindow, uint32 actual);
    error ZeroWindow();
    error ZeroAddress();
    error UriTooLong(uint256 length);
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlySeller(uint256 id) {
        _checkSeller(id);
        _;
    }

    function _checkSeller(uint256 id) internal view {
        if (_resources[id].seller != msg.sender) revert NotSeller();
    }

    function _checkTerms(uint32 window, string calldata uri) internal pure {
        if (window == 0) revert ZeroWindow();
        if (bytes(uri).length > MAX_URI) revert UriTooLong(bytes(uri).length);
    }

    // ------------------------------------------------------------------ sellers

    /// @notice Register a resource. `price` may be 0 (free, still records access).
    function createResource(uint96 price, uint32 window, string calldata uri) external returns (uint256 id) {
        _checkTerms(window, uri);
        id = nextId++;
        Resource storage r = _resources[id];
        r.seller = msg.sender;
        r.price = price;
        r.window = window;
        r.active = true;
        r.uri = uri;
        emit ResourceCreated(id, msg.sender, price, window, uri);
    }

    /// @notice Reprice, resize the window, pause/unpause, or change the uri.
    /// @dev    Already-granted access is never revoked: `hasAccess` ignores `active`.
    function updateResource(uint256 id, uint96 price, uint32 window, bool active, string calldata uri)
        external
        onlySeller(id)
    {
        _checkTerms(window, uri);
        Resource storage r = _resources[id];
        r.price = price;
        r.window = window;
        r.active = active;
        r.uri = uri;
        emit ResourceUpdated(id, price, window, active, uri);
    }

    /// @notice Hand a resource (and its future revenue) to another address.
    ///         Revenue already earned stays withdrawable by the previous seller.
    function transferResource(uint256 id, address to) external onlySeller(id) {
        if (to == address(0)) revert ZeroAddress();
        _resources[id].seller = to;
        emit ResourceTransferred(id, msg.sender, to);
    }

    /// @notice Pull accumulated USDC to yourself.
    function withdraw() external {
        _withdraw(payable(msg.sender));
    }

    /// @notice Pull accumulated USDC to another address (cold wallet, or a seller key
    ///         whose own receive hook reverts).
    function withdrawTo(address payable to) external {
        if (to == address(0)) revert ZeroAddress();
        _withdraw(to);
    }

    /// @dev Checks-effects-interactions: a re-entrant call sees a zero balance and reverts.
    function _withdraw(address payable to) internal {
        uint256 amt = balances[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, to, amt);
    }

    // ------------------------------------------------------------------ buyers

    /// @notice Pay for your own access.
    /// @param minWindow Revert unless the resource still grants at least this many seconds
    ///        (slippage guard: the seller cannot shrink the window between quote and pay).
    ///        The exact-amount check already guards the price. Pass 0 to accept any window.
    function pay(uint256 id, uint32 minWindow) external payable returns (uint64 until) {
        return _pay(id, msg.sender, minWindow);
    }

    /// @notice Pay on behalf of another address (e.g. an operator funding its agent's key).
    function payFor(uint256 id, address beneficiary, uint32 minWindow) external payable returns (uint64 until) {
        if (beneficiary == address(0)) revert ZeroAddress();
        return _pay(id, beneficiary, minWindow);
    }

    function _pay(uint256 id, address beneficiary, uint32 minWindow) internal returns (uint64 until) {
        Resource storage r = _resources[id];
        if (!r.active) revert Inactive(); // also covers ids that were never created
        if (msg.value != r.price) revert WrongAmount(r.price, msg.value);
        uint32 window = r.window;
        if (window < minWindow) revert WindowTooShort(minWindow, window);

        // Extend from the later of now / existing expiry so prepaying stacks windows.
        // uint64 + uint32 is checked arithmetic; overflow needs ~4e9 stacked max-windows.
        uint64 base = accessUntil[beneficiary][id];
        if (base < block.timestamp) base = uint64(block.timestamp);
        until = base + window;
        accessUntil[beneficiary][id] = until;

        r.sales += 1;
        if (msg.value > 0) {
            // msg.value <= price < 2^96, so revenue (uint128) needs > 2^32 sales at max price to overflow.
            r.revenue += uint128(msg.value);
            balances[r.seller] += msg.value;
        }
        emit Paid(id, msg.sender, beneficiary, msg.value, until);
    }

    // ------------------------------------------------------------------ views

    /// @notice True while `who` holds paid access to `id`. Access purchased at time t with
    ///         window w is valid for t <= now < t + w (exactly w seconds).
    function hasAccess(address who, uint256 id) external view returns (bool) {
        return accessUntil[who][id] > block.timestamp;
    }

    /// @notice Seconds of access `who` has left on `id` (0 if none).
    function remaining(address who, uint256 id) external view returns (uint256) {
        uint64 u = accessUntil[who][id];
        return u > block.timestamp ? u - block.timestamp : 0;
    }

    /// @notice Quote for a 402 response: price (wei), window, seller, active, uri.
    function quote(uint256 id)
        external
        view
        returns (uint96 price, uint32 window, address seller, bool active, string memory uri)
    {
        Resource storage r = _resources[id];
        return (r.price, r.window, r.seller, r.active, r.uri);
    }

    /// @notice Full record for one resource (seller == address(0) means it does not exist).
    function getResource(uint256 id) public view returns (ResourceView memory v) {
        Resource storage r = _resources[id];
        v = ResourceView(id, r.seller, r.price, r.window, r.active, r.sales, r.revenue, r.uri);
    }

    /// @notice Page through resources in id order, starting at `fromId` (ids start at 1).
    ///         Returns at most min(limit, MAX_PAGE) entries; an empty array past the end.
    function getResources(uint256 fromId, uint256 limit) external view returns (ResourceView[] memory out) {
        if (fromId == 0) fromId = 1;
        uint256 end = nextId;
        if (limit > MAX_PAGE) limit = MAX_PAGE;
        if (fromId >= end || limit == 0) return new ResourceView[](0);
        uint256 n = end - fromId;
        if (n > limit) n = limit;
        out = new ResourceView[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = getResource(fromId + i);
        }
    }
}
