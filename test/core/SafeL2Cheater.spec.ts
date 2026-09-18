import { expect } from "chai";
import hre, { deployments, waffle } from "hardhat";
import "@nomiclabs/hardhat-ethers";
import { deployContract } from "../utils/setup";

describe("SafeL2Cheater", async () => {
    const [user1] = waffle.provider.getWallets();

    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();

        // Mock OZ AccessManager: canCall returns (allow, 0). `allow` defaults true, toggle via setAllow.
        const authority = await deployContract(
            user1,
            `
            pragma solidity >=0.7.0 <0.9.0;
            contract MockAuthority {
                bool public allow = true;
                function setAllow(bool a) external { allow = a; }
                function canCall(address, address, bytes4) external view returns (bool, uint32) { return (allow, 0); }
            }`,
        );

        const cheaterFactory = await hre.ethers.getContractFactory("SafeL2Cheater");
        const cheater = await cheaterFactory.deploy(authority.address);

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
                function boom() external pure { revert("target reverted"); }
            }`,
        );

        const proxyAsCheater = cheaterFactory.attach(proxy.address);
        return { cheaterFactory, authority, proxyAsCheater, proxyAddress: proxy.address, target };
    });

    it("bakes the AccessManager as an immutable authority", async () => {
        const { authority, proxyAsCheater } = await setupTests();
        expect(await proxyAsCheater.authority()).to.eq(authority.address);
    });

    it("cheatCall runs target.call as the proxy (msg.sender) and forwards value when authorized", async () => {
        const { proxyAsCheater, proxyAddress, target } = await setupTests();
        const data = target.interface.encodeFunctionData("ping");

        await proxyAsCheater.cheatCall(target.address, data, { value: 123 });

        expect(await target.lastCaller()).to.eq(proxyAddress);
        expect(await target.lastValue()).to.eq(123);
    });

    it("reverts cheatCall when the AccessManager denies the caller", async () => {
        const { authority, proxyAsCheater, target } = await setupTests();
        await authority.setAllow(false);
        const data = target.interface.encodeFunctionData("ping");

        await expect(proxyAsCheater.cheatCall(target.address, data)).to.be.revertedWith("SafeL2Cheater: unauthorized");
    });

    it("reverts cheatUpgrade when the AccessManager denies the caller", async () => {
        const { cheaterFactory, authority, proxyAsCheater } = await setupTests();
        const newSingleton = await cheaterFactory.deploy(authority.address);
        await authority.setAllow(false);

        await expect(proxyAsCheater.cheatUpgrade(newSingleton.address)).to.be.revertedWith("SafeL2Cheater: unauthorized");
    });

    it("preserves the underlying SafeL2 logic (VERSION still readable through the proxy)", async () => {
        const { proxyAsCheater } = await setupTests();
        expect(await proxyAsCheater.VERSION()).to.eq("1.4.1");
    });

    it("cheatCall bubbles the target's revert reason on failure", async () => {
        const { proxyAsCheater, target } = await setupTests();
        const data = target.interface.encodeFunctionData("boom");

        await expect(proxyAsCheater.cheatCall(target.address, data)).to.be.revertedWith("target reverted");
    });

    it("cheatUpgrade re-points the proxy singleton to a new implementation when authorized", async () => {
        const { cheaterFactory, authority, proxyAsCheater, proxyAddress } = await setupTests();
        const newSingleton = await cheaterFactory.deploy(authority.address);

        await proxyAsCheater.cheatUpgrade(newSingleton.address);

        const slot0 = await hre.ethers.provider.getStorageAt(proxyAddress, 0);
        expect(hre.ethers.utils.getAddress("0x" + slot0.slice(-40))).to.eq(newSingleton.address);
    });

    it("cheatUpgrade rejects a singleton with no code (avoids bricking the proxy)", async () => {
        const { proxyAsCheater } = await setupTests();
        await expect(proxyAsCheater.cheatUpgrade(user1.address)).to.be.revertedWith("SafeL2Cheater: new singleton has no code");
    });
});
