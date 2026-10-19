// SPDX-License-Identifier: Open Source

pragma solidity ^0.8.30;

/**
 * @dev Test-only stand-in for magicVoter, with settable proposal state, to reach every boostQuorum branch.
 *      Not for deployment.
 */
contract MockMagicVoter {
    bool public canVoteResult;
    uint32 public createdAt;
    uint256 public delay;
    uint256 public yes;
    uint256 public no;
    bool public commitOnVote;
    bool public executedFlag;
    uint256 public lastPctYes;
    uint256 public lastPctNo;

    function setProposal(bool _canVote, uint32 _createdAt, uint256 _delay, uint256 _yes, uint256 _no, bool _commitOnVote) external {
        canVoteResult = _canVote;
        createdAt = _createdAt;
        delay = _delay;
        yes = _yes;
        no = _no;
        commitOnVote = _commitOnVote;
        executedFlag = false;
    }

    function voter() external view returns (address) { return address(this); }
    function canVote(uint256) external view returns (bool, uint32, uint256) { return (canVoteResult, createdAt, delay); }
    function timeToEpoch(uint256 timestamp) external pure returns (uint256) { return (timestamp - 1741824000) / 604800; }
    function voteTotals(address, uint256) external view returns (uint256, uint256) { return (yes, no); }
    function executed(address, uint256) external view returns (bool) { return executedFlag; }

    function vote(uint256, uint256 _pctYes, uint256 _pctNo) external {
        lastPctYes = _pctYes;
        lastPctNo = _pctNo;
        if (commitOnVote) executedFlag = true;
    }
}
