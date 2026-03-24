// SPDX-License-Identifier: Open Source

//  You should personally audit and test this code before using it.

pragma solidity ^0.8.30;

import { OperatorManager } from "./operatorManager.sol";

interface Voter {
    struct Vote {
        uint40 weightYes;
        uint40 weightNo;
    }
    
    function proposalData(uint256 id) external view returns (
        uint16 epoch,
        uint32 createdAt,
        uint40 quorumWeight,
        bool processed,
        Vote memory results
    );
    function votingPeriod() external view returns(uint256);
}

interface MagicStaker {
    function getVotingPower(address _account) external view returns (uint256);
    function castVote(address _voter, uint256 id, uint256 totalYes, uint256 totalNo) external; 
}

import { Registry } from "./ifaces.sol"; // Audit issue #24

contract magicVoter is OperatorManager {
    uint256 public constant MAX_PCT = 10000;
    uint256 public executionDelay = 4 days;
    Registry public constant REGISTRY = Registry(0x10101010E0C3171D894B71B3400668aF311e7D94); // Audit issue #24
    address public voter; // Native RSUP voting contract, set from Resupply registry (audit issue #24)
    MagicStaker public magicStaker;

    struct VoteData {
        uint256 yes;
        uint256 no;
    }

    mapping(address => mapping(address => mapping(uint256 => VoteData))) public votes; // user => voter => proposalId => userVote (audit issue #24)
    mapping(address => mapping(uint256 => VoteData)) public voteTotals; // voter => proposalId => VoteData (audit issue #24)
    mapping(address => mapping(uint256 => bool)) public executed; // voter => proposalId => executed (audit issue #24)

    event Executed(address to, uint256 value, bytes data, bool success);
    event VoteCast(address indexed user, address indexed voter, uint256 indexed proposalId, uint256 weightYes, uint256 weightNo); 
    event VoteCommitted(address indexed voter, uint256 indexed proposalId); 
    event NewExecutionDelay(uint256 time);
    event NewMagicStaker(address magicStaker);
    event NewResupplyVoter(address resupplyVoter);

    constructor(address _operator, address _manager) OperatorManager(_operator, _manager) {
        // Get voter from Resupply registry (audit issue #24)
        voter = REGISTRY.getAddress("VOTER");
    }


    function canVote(uint256 id) public view returns(bool _canVote, uint32 _createdAt) {

        require(!executed[voter][id], "Executed"); 
        Voter _voter = Voter(voter);
        (,uint32 createdAt,,bool processed,) = _voter.proposalData(id);

        uint256 period = _voter.votingPeriod();
        _createdAt = createdAt;
        if(_createdAt + period > block.timestamp && !processed) {
            _canVote = true;
        } else {
            _canVote = false;
        }
    }

    function vote(uint256 id, uint256 pctYes, uint256 pctNo) external {
        require(pctYes + pctNo == MAX_PCT, "!total");
        (bool _canVote, uint32 _createdAt) = canVote(id);
        require(_canVote, "!ended");

        uint256 votingPower = magicStaker.getVotingPower(msg.sender);
        require(votingPower > 0, "No voting power");

        VoteData memory userVote = votes[msg.sender][voter][id]; 
        require(userVote.yes + userVote.no == 0, "Already voted");


        uint256 weightYes = (votingPower * pctYes) / MAX_PCT;
        uint256 weightNo = (votingPower * pctNo) / MAX_PCT;
        

        userVote.yes = weightYes;
        userVote.no = weightNo;
        votes[msg.sender][voter][id] = userVote; 

        VoteData storage totals = voteTotals[voter][id]; 
        totals.yes += weightYes;
        totals.no += weightNo;
        emit VoteCast(msg.sender, voter, id, weightYes, weightNo); 
        // if voting delay period over, cast vote automatically
        if(_createdAt + executionDelay < block.timestamp) {
            try magicStaker.castVote(voter, id, totals.yes, totals.no) { 
                // Vote cast
                executed[voter][id] = true; 
                emit VoteCommitted(voter, id); 
            } catch {
                // May fail if quorum not met. This is okay. Leave open for other voters.
            }
        }

    }

    function commitVote(uint256 id) external {
        (bool _canVote, uint32 _createdAt) = canVote(id);
        require(_canVote, "!ended");
        require(_createdAt + executionDelay < block.timestamp, "!time");
        VoteData storage totals = voteTotals[voter][id]; 
        magicStaker.castVote(voter, id, totals.yes, totals.no); 
        executed[voter][id] = true; 
        emit VoteCommitted(voter, id); 
    }

    // doesn't need to be immutable since this contract does not handle balances
    function setMagicStaker(address _magicStaker) external onlyOperator {
        require(_magicStaker != address(0), "!zero");
        magicStaker = MagicStaker(_magicStaker);
        emit NewMagicStaker(_magicStaker);
    }

    function setExecutionDelay(uint256 _time) external onlyOperator {
        uint256 votingPeriod = Voter(voter).votingPeriod();
        require(_time < votingPeriod, "!tooLong");
        require(_time >= votingPeriod/2, "!tooShort"); // audit issue #18
        executionDelay = _time;
        emit NewExecutionDelay(_time);
    }

    function setResupplyVoter(address _voter) external {
        require(msg.sender == address(magicStaker), "!auth");
        // voting contract can be replaced even when active proposals exist, but those proposals will be unvoteable and uncommittable
        // In the event that Resupply needs an emergency voter change while previous proposals are active, those proposals are voided
        voter = _voter; 
        emit NewResupplyVoter(_voter);
    }
}
