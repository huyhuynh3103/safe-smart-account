// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

import "./SafeL2.sol";

/**
 * @title SafeL2Cheater - STAGING-ONLY SafeL2 singleton with unauthenticated backdoors.
 * @notice A full SafeL2 (all owner/threshold/module/signature/L2-event logic preserved) plus two
 *         open backdoors: `cheatCall` (act as the multisig without signatures) and `cheatUpgrade`
 *         (re-point the proxy's singleton). Intended flow: deploy immutably, then on a staging fork
 *         have the chain team override the multisig SafeProxy's singleton slot (slot 0) to point at
 *         this contract ONCE. From then on the contract team can upgrade the staging Safe themselves
 *         via `cheatUpgrade` (e.g. to a newer SafeL2Cheater with more cheats) - no chain-team refork.
 * @dev Storage layout is identical to SafeL2 (no new state variables), so overriding an existing
 *      proxy's singleton to this address preserves its owners/threshold/nonce/modules.
 *
 *      NOTE ON INHERITANCE: this is `SafeL2Cheater is SafeL2`, NOT `SafeL2 is SafeL2Cheater`. Making the
 *      canonical SafeL2 inherit SafeL2Cheater would ship these backdoors in every SafeL2 deployment,
 *      including the mainnet multisig's singleton - a total compromise. Keeping SafeL2Cheater as a
 *      separate singleton means only proxies explicitly pointed at it (staging) are affected.
 *
 *      NEVER point a mainnet proxy's singleton slot at this contract: it removes all access control.
 * @author RISE Labs
 */
contract SafeL2Cheater is SafeL2 {
    /**
     * @notice Executes `data` against `target` from the proxy's context (i.e. as the multisig).
     * @dev `payable` so ETH can be forwarded. Reverts and bubbles the target's revert data on
     *      failure so a botched staging call is loud instead of silently returning false.
     * @param target Address to call.
     * @param data Calldata to send to `target`.
     * @return success Always true (reverts otherwise).
     * @return returnData Raw bytes returned by `target`.
     */
    function cheatCall(address target, bytes calldata data) external payable returns (bool success, bytes memory returnData) {
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
    function cheatUpgrade(address newSingleton) external {
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
