import { expect } from "chai";
import hre, { deployments, waffle } from "hardhat";
import "@nomiclabs/hardhat-ethers";
import { deployContract } from "../utils/setup";

describe("SafeL2Cheater", async () => {
    const [user1] = waffle.provider.getWallets();

    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();

        const cheaterFactory = await hre.ethers.getContractFactory("SafeL2Cheater");
        const cheater = await cheaterFactory.deploy();

        // A SafeProxy delegatecalls its singleton (slot 0). Pointing the singleton at SafeL2Cheater
        // mimics the staging slot-0 override the chain team performs on the multisig proxy.
        const proxyFactory = await hre.ethers.getContractFactory("SafeProxy");
        const proxy = await proxyFactory.deploy(cheater.address);

        // Target records who called it, so we can prove the call ran as the proxy (the "multisig").
        const target = await deployContract(
            user1,
            `
            pragma solidity >=0.7.0 <0.9.0;
            contract Target {
                address public lastCaller;
                uint256 public lastValue;
                function ping() external payable returns (uint256) {
                    lastCaller = msg.sender;
                    lastValue = msg.value;
                    return 42;
                }
                function boom() external pure {
                    revert("target reverted");
                }
            }`,
        );

        // Talk to the proxy through the SafeL2Cheater ABI.
        const proxyAsSafeL2Cheater = cheaterFactory.attach(proxy.address);
        return { cheaterFactory, proxyAsSafeL2Cheater, proxyAddress: proxy.address, target };
    });

    it("cheatCall runs target.call as the proxy (msg.sender) and forwards value", async () => {
        const { proxyAsSafeL2Cheater, proxyAddress, target } = await setupTests();
        const data = target.interface.encodeFunctionData("ping");

        await proxyAsSafeL2Cheater.cheatCall(target.address, data, { value: 123 });

        expect(await target.lastCaller()).to.eq(proxyAddress);
        expect(await target.lastValue()).to.eq(123);
    });

    it("preserves the underlying SafeL2 logic (VERSION still readable through the proxy)", async () => {
        const { proxyAsSafeL2Cheater } = await setupTests();
        expect(await proxyAsSafeL2Cheater.VERSION()).to.eq("1.4.1");
    });

    it("cheatCall bubbles the target's revert reason on failure", async () => {
        const { proxyAsSafeL2Cheater, target } = await setupTests();
        const data = target.interface.encodeFunctionData("boom");

        await expect(proxyAsSafeL2Cheater.cheatCall(target.address, data)).to.be.revertedWith("target reverted");
    });

    it("cheatUpgrade re-points the proxy singleton to a new implementation", async () => {
        const { cheaterFactory, proxyAsSafeL2Cheater, proxyAddress } = await setupTests();

        // Deploy a second SafeL2Cheater and upgrade the proxy to it.
        const newSingleton = await cheaterFactory.deploy();
        await proxyAsSafeL2Cheater.cheatUpgrade(newSingleton.address);

        // Slot 0 (the proxy's singleton pointer) now holds the new implementation address.
        const slot0 = await hre.ethers.provider.getStorageAt(proxyAddress, 0);
        expect(hre.ethers.utils.getAddress("0x" + slot0.slice(-40))).to.eq(newSingleton.address);
    });

    it("cheatUpgrade rejects a singleton with no code (avoids bricking the proxy)", async () => {
        const { proxyAsSafeL2Cheater } = await setupTests();
        await expect(proxyAsSafeL2Cheater.cheatUpgrade(user1.address)).to.be.revertedWith("SafeL2Cheater: new singleton has no code");
    });
});
