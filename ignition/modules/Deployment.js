const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

const _operator = "0xB4421830226F9C5Ff32060B96a3b9F8D2E0E132D";
const _manager = "0xdC7C7F0bEA8444c12ec98Ec626ff071c6fA27a19";


const MagicPounderModule = buildModule("DeployMagicPounder", (m) => {

    const operator = m.getParameter("_operator", _operator);
    const manager = m.getParameter("_manager", _manager);

    const MagicPounder = m.contract("magicPounder", [operator, manager]);

    return { MagicPounder };
});


const MagicVoterModule = buildModule("DeployMagicVoter", (m) => {

    const operator = m.getParameter("_operator", _operator);
    const manager = m.getParameter("_manager", _manager);

    const MagicVoter = m.contract("magicVoter", [operator, manager]);

    return { MagicVoter };
});


const MagicStakerModule = buildModule("DeployMagicStaker", (m) => {

    const magicPounder = m.getParameter("_magicPounder", "0x0000000000000000000000000000000000000000");
    const magicVoter = m.getParameter("_magicVoter", "0x0000000000000000000000000000000000000000");
    const operator = m.getParameter("_operator", _operator);
    const manager = m.getParameter("_manager", _manager);

    const MagicStaker = m.contract("magicStaker", [magicPounder, magicVoter, operator, manager]);

    return { MagicStaker };
});


const MagicHarvesterModule = buildModule("DeployMagicHarvester", (m) => {

    const operator = m.getParameter("_operator", _operator);
    const manager = m.getParameter("_manager", _manager);

    const MagicHarvester = m.contract("magicHarvester", [operator, manager]);

    return { MagicHarvester };
});

const MagicSavingsModule = buildModule("DeployMagicSavings", (m) => {

    const magicStaker = m.getParameter("_magicStaker", "0x0000000000000000000000000000000000000000");
    const operator = m.getParameter("_operator", _operator);
    const manager = m.getParameter("_manager", _manager);

    const MagicSavings = m.contract("magicSavings", [magicStaker, operator, manager]);

    return { MagicSavings };
});

module.exports = { MagicPounderModule, MagicVoterModule, MagicStakerModule, MagicHarvesterModule, MagicSavingsModule };