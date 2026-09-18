import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// SafeL2Cheater is a staging-only tool (see contracts/SafeL2Cheater.sol). It is intentionally NOT tagged
// into "main-suite"/"l2-suite" so it is never swept into a normal Safe deployment. Deploy it
// explicitly with `--tags cheater`.
//
// Deployment is nonce-based (deterministicDeployment default false) so it does NOT depend on the
// Safe singleton factory, which the pinned @gnosis.pm/safe-singleton-factory package does not know
// about for RISE's chainId. Set DETERMINISTIC=1 only on chains that factory supports if you want a
// reproducible address.
const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();
    const { deploy } = deployments;

    await deploy("SafeL2Cheater", {
        from: deployer,
        args: [],
        log: true,
        deterministicDeployment: !!process.env.DETERMINISTIC,
    });
};

deploy.tags = ["cheater"];
export default deploy;
