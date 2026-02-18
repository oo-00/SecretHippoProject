var { ethers } = require("hardhat");

var { MagicPounderModule, MagicVoterModule, MagicStakerModule, MagicHarvesterModule, MagicSavingsModule } = require("../ignition/modules/Deployment");

var erc20Abi = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)",
    "function allowance(address owner, address spender) external view returns (uint256)",
];

var stakerAbi = [
    "function earned(address _account, address _rewardToken) external view returns (uint256)",
]

async function reUSDSetUp() {
    var reUSD;
    var reUSDAddress = "0x57aB1E0003F623289CD798B1824Be09a793e4Bec";
    reUSD = new ethers.Contract(reUSDAddress, erc20Abi, ethers.provider);
    return reUSD;
}

async function RSUPSetUp() {
    var RSUP;
    var RSUPAddress = "0x419905009e4656fdC02418C7Df35B1E61Ed5F726";
    RSUP = new ethers.Contract(RSUPAddress, erc20Abi, ethers.provider);
    return RSUP;
}

async function sreUSDSetUp() {
    var sreUSD;
    var sreUSDAddress = "0x557AB1e003951A73c12D16F0fEA8490E39C33C35";
    sreUSD = new ethers.Contract(sreUSDAddress, erc20Abi, ethers.provider);
    return sreUSD;
}

async function stakerSetUp() {
    var staker;
    var stakerAddress = "0x22222222E9fE38F6f1FC8C61b25228adB4D8B953";
    staker = new ethers.Contract(stakerAddress, stakerAbi, ethers.provider);
    return staker;
}



async function voterSetUp() {
    var voter;
    var voterAbi = [{"inputs":[{"internalType":"address","name":"_core","type":"address"},{"internalType":"contract IGovStaker","name":"_staker","type":"address"},{"internalType":"uint256","name":"_minCreateProposalPct","type":"uint256"},{"internalType":"uint256","name":"_quorumPct","type":"uint256"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":true,"internalType":"address","name":"delegate","type":"address"},{"indexed":false,"internalType":"bool","name":"isApproved","type":"bool"}],"name":"DelegateApprovalSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"delay","type":"uint256"}],"name":"ExecutionDelaySet","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"cooldown","type":"uint256"}],"name":"MinTimeBetweenProposalsSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"proposalId","type":"uint256"}],"name":"ProposalCancelled","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"}],"indexed":false,"internalType":"struct Voter.Action[]","name":"payload","type":"tuple[]"},{"indexed":false,"internalType":"uint256","name":"epoch","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"quorumWeight","type":"uint256"}],"name":"ProposalCreated","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"weight","type":"uint256"}],"name":"ProposalCreationMinPctSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"proposalId","type":"uint256"},{"indexed":false,"internalType":"string","name":"description","type":"string"}],"name":"ProposalDescriptionUpdated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"proposalId","type":"uint256"}],"name":"ProposalExecuted","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"weight","type":"uint256"}],"name":"QuorumPctSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"weightYes","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"weightNo","type":"uint256"}],"name":"VoteCast","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"period","type":"uint256"}],"name":"VotingPeriodSet","type":"event"},{"inputs":[],"name":"EXECUTION_DEADLINE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"MAX_DESCRIPTION_BYTES","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"MAX_PCT","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"TOKEN_DECIMALS","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"id","type":"uint256"}],"name":"accountVoteWeights","outputs":[{"internalType":"uint40","name":"weightYes","type":"uint40"},{"internalType":"uint40","name":"weightNo","type":"uint40"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"canExecute","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"cancelProposal","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"core","outputs":[{"internalType":"contract ICore","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"}],"internalType":"struct Voter.Action[]","name":"payload","type":"tuple[]"},{"internalType":"string","name":"description","type":"string"}],"name":"createNewProposal","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"epochLength","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"executeProposal","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"executionDelay","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getEpoch","outputs":[{"internalType":"uint256","name":"epoch","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getProposalCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"getProposalData","outputs":[{"internalType":"string","name":"description","type":"string"},{"internalType":"uint256","name":"epoch","type":"uint256"},{"internalType":"uint256","name":"createdAt","type":"uint256"},{"internalType":"uint256","name":"quorumWeight","type":"uint256"},{"internalType":"uint256","name":"weightYes","type":"uint256"},{"internalType":"uint256","name":"weightNo","type":"uint256"},{"internalType":"bool","name":"processed","type":"bool"},{"internalType":"bool","name":"executable","type":"bool"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"}],"internalType":"struct Voter.Action[]","name":"payload","type":"tuple[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"caller","type":"address"}],"name":"isApprovedDelegate","outputs":[{"internalType":"bool","name":"isApproved","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"latestProposalTimestamp","outputs":[{"internalType":"uint256","name":"timestamp","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"minCreateProposalPct","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"minCreateProposalWeight","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"minTimeBetweenProposals","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"proposalData","outputs":[{"internalType":"uint16","name":"epoch","type":"uint16"},{"internalType":"uint32","name":"createdAt","type":"uint32"},{"internalType":"uint40","name":"quorumWeight","type":"uint40"},{"internalType":"bool","name":"processed","type":"bool"},{"components":[{"internalType":"uint40","name":"weightYes","type":"uint40"},{"internalType":"uint40","name":"weightNo","type":"uint40"}],"internalType":"struct Voter.Vote","name":"results","type":"tuple"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"proposalDescription","outputs":[{"internalType":"string","name":"description","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"uint256","name":"","type":"uint256"}],"name":"proposalPayload","outputs":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"quorumPct","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"quorumReached","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"_delegate","type":"address"},{"internalType":"bool","name":"_isApproved","type":"bool"}],"name":"setDelegateApproval","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_delay","type":"uint256"}],"name":"setExecutionDelay","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"pct","type":"uint256"}],"name":"setMinCreateProposalPct","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_cooldown","type":"uint256"}],"name":"setMinTimeBetweenProposals","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"pct","type":"uint256"}],"name":"setQuorumPct","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_period","type":"uint256"}],"name":"setVotingPeriod","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"staker","outputs":[{"internalType":"contract IGovStaker","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"startTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"string","name":"description","type":"string"}],"name":"updateProposalDescription","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"id","type":"uint256"}],"name":"voteForProposal","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"uint256","name":"pctYes","type":"uint256"},{"internalType":"uint256","name":"pctNo","type":"uint256"}],"name":"voteForProposal","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"votingPeriod","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]
    var voterAddress = "0x11111111063874cE8dC6232cb5C1C849359476E6";
    voter = new ethers.Contract(voterAddress, voterAbi, ethers.provider);
    return voter;
}

async function setUpSmartContracts() {
    var reUSD = await reUSDSetUp();
    var RSUP = await RSUPSetUp();
    var sreUSD = await sreUSDSetUp();
    var staker = await stakerSetUp();
    var voter = await voterSetUp();

    var operator = "0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e";
    var manager = "0xdC7C7F0bEA8444c12ec98Ec626ff071c6fA27a19";

    const { MagicPounder } = await ignition.deploy(MagicPounderModule, {
    parameters: {
        DeployMagicPounder: {
        _operator: operator,
        _manager: manager,
        },
    },
    });

    const { MagicVoter } = await ignition.deploy(MagicVoterModule, {
    parameters: {
        DeployMagicVoter: {
        _operator: operator,
        _manager: manager,
        },
    },
    });

    var pounder = await MagicPounder.getAddress();
    var mvoter = await MagicVoter.getAddress();

    const { MagicStaker } = await ignition.deploy(MagicStakerModule, {
    parameters: {
        DeployMagicStaker: {
        _magicPounder: pounder,
        _magicVoter: mvoter,
        _operator: operator,
        _manager: manager,
        },
    },
    });

    var magicStakerAddress = await MagicStaker.getAddress();

    const { MagicHarvester } = await ignition.deploy(MagicHarvesterModule, {
    parameters: {
        DeployMagicHarvester: {
        _operator: operator,
        _manager: manager,
        },
    },
    });

    var sreUSDAddress = "0x557AB1e003951A73c12D16F0fEA8490E39C33C35";
    const { MagicSavings } = await ignition.deploy(MagicSavingsModule, {
    parameters: {
        DeployMagicSavings: {
        _magicStaker: magicStakerAddress,
        _operator: operator,
        _manager: manager
        },
    },
    });


    return { MagicPounder, MagicVoter, MagicStaker, MagicHarvester, MagicSavings, manager, operator, reUSD, RSUP, sreUSD, staker, voter };
}

module.exports = { setUpSmartContracts };