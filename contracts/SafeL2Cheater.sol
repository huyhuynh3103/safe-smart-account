// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

import "./SafeL2.sol";

/**
 * @title IAccessManager - minimal view of OpenZeppelin's AccessManager (v5).
 * @dev Matches the on-chain `canCall` signature so a real deployed OZ AccessManager works unchanged.
 *      We cannot import OZ's AccessManaged directly: it is OZ v5 / Solidity ^0.8.20, while this
 *      contract inherits the audited Safe 1.4.1 tree, which compiles under 0.7.6.
 */
interface IAccessManager {
    /// @return immediate Whether `caller` can call `target.selector` right now (no scheduled delay).
    /// @return delay The execution delay, if the call must be scheduled instead of run immediately.
    function canCall(address caller, address target, bytes4 selector)
        external
        view
        returns (bool immediate, uint32 delay);
}

/**
 * @title SafeL2Cheater - STAGING-ONLY SafeL2 singleton with AccessManager-gated backdoors.
 * @notice A full SafeL2 (all owner/threshold/module/signature/L2-event logic preserved) plus two
 *         backdoors, `cheatCall` and `cheatUpgrade`, each gated by an OpenZeppelin AccessManager
 *         (see https://docs.openzeppelin.com/contracts/5.x/api/access#AccessManager). Intended flow:
 *         deploy immutably with the AccessManager address, then on a staging fork have the chain team
 *         override the multisig SafeProxy's singleton slot (slot 0) to point at this contract ONCE.
 *         From then on any address the AccessManager authorizes can act as the multisig
 *         (`cheatCall`) or re-point the singleton (`cheatUpgrade`) - no owner signatures, no refork.
 * @dev The `authority` is immutable, so it lives in this contract's CODE, not storage - it survives
 *      the proxy delegatecall and does not collide with the proxy's slot-0 `singleton`. Because the
 *      backdoors run via delegatecall, `address(this)` inside `restricted` is the PROXY (the
 *      multisig): configure the AccessManager to grant roles on the proxy address as the target.
 *
 *      Adds no storage, so overriding an existing proxy's singleton to this preserves its
 *      owners/threshold/nonce/modules.
 *
 *      NEVER point a mainnet proxy's singleton slot at this contract: even gated, it is a
 *      "become the multisig" primitive whose blast radius is only as safe as the AccessManager.
 * @author RISE Labs
 */
contract SafeL2Cheater is SafeL2 {
    address public immutable masterAdmin;
    /// @notice The OpenZeppelin AccessManager that authorizes the cheat functions. Immutable.
    address public immutable authority;

    /**
     * @param _authority Address of the deployed OZ AccessManager.
     * @dev The inherited Safe constructor (no args) also runs, bricking this singleton's own storage.
     */
    constructor(address _authority) {
        require(_authority != address(0), "SafeL2Cheater: zero authority");
        authority = _authority;
        masterAdmin = msg.sender;
    }

    /**
     * @dev Reverts unless the AccessManager grants `msg.sender` immediate access to this selector on
     *      this target (the proxy). Scheduled/delayed grants (delay > 0) are treated as unauthorized:
     *      this is a staging tool, use immediate grants.
     */
    modifier restricted() {
        if (masterAdmin == msg.sender) _;
        (bool immediate,) = IAccessManager(authority).canCall(msg.sender, address(this), msg.sig);
        require(immediate, "SafeL2Cheater: unauthorized");
        _;
    }

    /**
     * @notice Executes `data` against `target` from the proxy's context (i.e. as the multisig).
     * @dev `payable` so ETH can be forwarded. Reverts and bubbles the target's revert data on failure.
     * @param target Address to call.
     * @param data Calldata to send to `target`.
     * @return success Always true (reverts otherwise).
     * @return returnData Raw bytes returned by `target`.
     */
    function cheatCall(address target, bytes calldata data)
        external
        payable
        restricted
        returns (bool success, bytes memory returnData)
    {
        (success, returnData) = target.call{value: msg.value}(data);
        if (!success) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }
    }

    /**
     * @notice Re-points this proxy's singleton (slot 0) to `newSingleton`, upgrading the staging Safe.
     * @dev Runs via delegatecall from the proxy, so `sstore(0, newSingleton)` overwrites the proxy's
     *      own `singleton` pointer. Requires code at `newSingleton` to avoid bricking the proxy.
     *      Point it at a newer SafeL2Cheater to keep the backdoors after upgrading.
     * @param newSingleton Address of the new singleton/implementation. Must contain code.
     */
    function cheatUpgrade(address newSingleton) external restricted {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(newSingleton)
        }
        require(size > 0, "SafeL2Cheater: new singleton has no code");
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sstore(0, newSingleton)
        }
    }
}
