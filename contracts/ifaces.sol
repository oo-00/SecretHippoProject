// SPDX-License-Identifier: Open Source

pragma solidity ^0.8.30;

interface Registry {
    function getAddress(string memory key) external view returns (address);
}

interface Staker {
    function stake(uint _amount) external returns (uint);
    function cooldown(address _account, uint _amount) external returns (uint);
    function unstake(address _account, address _receiver) external returns (uint);
    function getReward(address _account) external;
    function cooldownEpochs() external view returns (uint);
}

interface Strategy {
    function setUserBalance(address _account, uint256 _balance) external;
    function balanceOf(address _account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function notifyReward(uint256 _amount) external;
    function desiredToken() external view returns(address);
    function subtractFee(address _account, uint256 _fee) external;
}

interface Harvester {
    struct Route {
        address pool;
        address tokenIn;
        address tokenOut;
        uint256 functionType;
        uint256 indexIn;
        uint256 indexOut;
    }
    function process(address[10] memory _tokenIn, uint256[10] memory _amountsIn, address _strategy) external returns (uint256);
    function getRoute(address _tokenIn, address _tokenOut) external view returns (Route[] memory);
}

interface Voter {
    struct Action {
        address target;
        bytes data;
    }
    function voteForProposal(address account, uint256 id, uint256 pctYes, uint256 pctNo) external;
    function createNewProposal(address account, Action[] calldata payload, string calldata description) external returns (uint256);
    function setDelegateApproval(address _delegate, bool _isApproved) external;
    function minCreateProposalWeight() external view returns (uint256);
}

interface MagicVoter {
    function setResupplyVoter(address _voter) external;
}