// SPDX-License-Identifier: Open Source

/*

    Multi-strategy staking contract for Resupply (RSUP) token with integrated voting power.

    You should personally audit and test this code before using it.

    Requires local quorum of 20% to cast a meta-vote to Resupply.

*/

pragma solidity ^0.8.30;

import { IERC20, SafeERC20 } from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import { OperatorManager } from "./operatorManager.sol";
import { Registry, Staker, Strategy, Harvester, Voter, MagicVoter } from "./ifaces.sol";

contract magicStaker is OperatorManager {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------
    // STRUCTS
    // ------------------------------------------------------------------------
    struct AccountStakeData {
        uint112 realizedStake; // Amount of stake that has fully realized weight.
        uint112 pendingStake; // Amount of stake that has not yet fully realized weight.
        uint112 magicStake; // Amount of synced stake in magic pounder.
        uint16 lastUpdateEpoch;
    }

    struct AccountWeightData {
        uint112[] weights; // Strategy weights
        uint16 lastUpdateEpoch; // last change
    }

    struct CooldownData {
        uint256 amount;
        uint256 maturityEpoch;
    }

    // ------------------------------------------------------------------------
    // VARIABLES
    // ------------------------------------------------------------------------

    // Constants
    uint256 public constant DENOM = 10000;
    uint256 public constant MAX_CALL_FEE = 100;  // 1 %
    Registry public constant REGISTRY = Registry(0x10101010E0C3171D894B71B3400668aF311e7D94);
   
    IERC20 public constant RSUP = IERC20(0x419905009e4656fdC02418C7Df35B1E61Ed5F726);

    // Interfaced Contracts
    IERC20[] public rewards; // native reward tokens from staker
    Staker public staker; // Native RSUP voting contract, set from Resupply registry (audit issue #20)
    Voter public voter; // Native RSUP voting contract, set from Resupply registry

    // System
    address public magicVoter; // meta-voting contract
    uint256 public totalSupply; // total staked RSUP not in cooldown
    uint256 public CALL_FEE = 5;  // 0.05 % harvest caller incentive
    address[] public strategies;
    uint256 public pendingCooldownEpoch = type(uint256).max; // global tracking, max when no pending cooldowns
    bool paused;

    mapping(address => bool) public isStrategy; // Audit issue #25
    mapping(address => bool) public isRewardToken;
    mapping(address strategy => address harvester) public strategyHarvester;   

    // User account data
    mapping(address => AccountStakeData) public accountStakeData;
    mapping(address => CooldownData) public accountCooldownData;
    mapping(address => AccountWeightData) public accountWeightData;

    // Vote power/supply tracking
    mapping(address account => uint256 createDelay) public proposalCreationDelay; // tracks when accounts can create proposals again, to prevent spam
    mapping(uint epoch => uint weight) private totalPowerAt;
    mapping(address account => mapping(uint epoch => uint weight)) private accountPowerAt;
    uint112 public totalPending;
    uint16 public totalLastUpdateEpoch;

    // ------------------------------------------------------------------------
    // EVENTS
    // ------------------------------------------------------------------------
    event Stake(address indexed user, uint256 epoch, uint256 amount);
    event Cooldown(address indexed user, uint256 amount);
    event Unstake(address indexed user, uint256 amount);
    event Harvest(address indexed reward, uint256 amount);
    event SetWeights(address indexed user, uint112[] weights);
    event MagicClaim(address indexed user, uint256 amount);
    event VoteCast(uint256 proposalId, uint256 weightYes, uint256 weightNo);
    event MagicStake(uint256 amount);
    event NewRewardToken(address rewardToken);
    event RemoveRewardToken(address rewardToken);
    event StrategyHarvesterSet(address strategy, address harvester);
    event CallFeeSet(uint256 newFee);
    event MagicFeeSet(uint256 newFee);
    event StrategyAdded(address strategy);
    event MagicVoterSet(address voter);
    event ResupplyVoterSet(address voter);
    event DelegateApprovalSet(address delegate, bool isApproved);
    event Executed(address to, uint256 value, bytes data, bool success);

    // ------------------------------------------------------------------------
    // ERRORS
    // ------------------------------------------------------------------------

    error OldEpoch();
    error InvalidAmount();
    error InsufficientRealizedStake();
    error CooldownsPending();

    // ------------------------------------------------------------------------
    // CONSTRUCTOR
    // ------------------------------------------------------------------------
    constructor(address _magicPounder, address _magicVoter, address _operator, address _manager) OperatorManager(_operator, _manager) {
        // assign resupply addresses from registry
        voter = Voter(REGISTRY.getAddress("VOTER"));
        staker = Staker(REGISTRY.getAddress("STAKER"));
        
        // pre-approve staker
        RSUP.approve(address(staker), type(uint256).max);

        magicVoter = _magicVoter;

        // strategy 0 is immutable magic compounder
        strategies.push(_magicPounder);
        isStrategy[_magicPounder] = true;

        // add reusd to rewards
        rewards.push(IERC20(0x57aB1E0003F623289CD798B1824Be09a793e4Bec));
        isRewardToken[0x57aB1E0003F623289CD798B1824Be09a793e4Bec] = true;
    }


    // ------------------------------------------------------------------------
    // VIEWs
    // ------------------------------------------------------------------------
    
    function balanceOf(address _account) public view returns (uint256) {
        return accountStakeData[_account].realizedStake + accountStakeData[_account].pendingStake;
    }

    function rewardsLength() public view returns (uint256) {
        return rewards.length;
    }

    /**
     * @notice Current Resupply epoch
     */
    function getEpoch() public view returns (uint256 epoch) {
        return (block.timestamp - 1741824000) / 604800;
    }

    function isCooldownEpoch() public view returns (bool) {
        uint256 cde = staker.cooldownEpochs();
        uint256 epoch = getEpoch();
        if(epoch % (cde + 1) == 0) {
            return true;
        } else {
            return false;
        }
    }

    function strategiesLength() public view returns (uint256) {
        return strategies.length;
    }

    function strategyBalanceOf(address _strategy, address _account) public view returns (uint256) {
        return Strategy(_strategy).balanceOf(_account);
    }

    function unclaimedMagicTokens(address _account) public view returns (uint256) {
        AccountStakeData memory accountData = accountStakeData[_account];
        uint256 currentMagicBalance = Strategy(strategies[0]).balanceOf(_account);
        if (currentMagicBalance > accountData.magicStake) {
            uint256 diff = currentMagicBalance - accountData.magicStake;
            return diff;
        }
        return 0;
    }

    function accountStrategyWeight(address _account, uint256 _strategyIndex) public view returns (uint112) {
        AccountWeightData memory weightData = accountWeightData[_account];
        require(_strategyIndex < weightData.weights.length, "!index");
        return weightData.weights[_strategyIndex];
    }


    // ------------------------------------------------------------------------
    // VOTING
    // ------------------------------------------------------------------------
    /**
        @notice View function to get the current power for an account
    */
    function getVotingPower(address account) public view returns (uint) {
        return getVotingPowerAt(account, getEpoch());
    }

    /**
        @notice Get the power for an account in a given epoch
    */
    function getVotingPowerAt(address _account, uint _epoch) public view returns (uint) {
        if (_epoch > getEpoch()) return 0;

        AccountStakeData memory acctData = accountStakeData[_account];

        uint16 lastUpdateEpoch = acctData.lastUpdateEpoch;

        if (lastUpdateEpoch >= _epoch) return accountPowerAt[_account][_epoch];

        uint weight = accountPowerAt[_account][lastUpdateEpoch];

        uint pending = uint(acctData.pendingStake);
        if (pending == 0) return weight;

        return pending + weight;
    }

    function createProposal(Voter.Action[] calldata payload, string calldata description) external returns (uint256 proposalId) {
        // verify this contract has enough voting power to create proposal
        require(getVotingPower(msg.sender) >= voter.minCreateProposalWeight(), "!weight");
        // verify user is not creating proposals too frequently
        require(block.timestamp >= proposalCreationDelay[msg.sender], "!delay");
        proposalId = voter.createNewProposal(address(this), payload, description);
        // additional 7 day delay for individual accounts to create proposals, since all users share this privilege
        proposalCreationDelay[msg.sender] = block.timestamp + voter.minTimeBetweenProposals() + 7 days;
    }

    function castVote(address _voter, uint256 id, uint256 totalYes, uint256 totalNo) external {
        require(msg.sender == magicVoter, "!voter");
        require(_voter == address(voter), "!voter"); // audit issue #24 - ensure only votes for correct voter contract are cast
        uint256 total = totalYes + totalNo;
        require((totalPowerAt[totalLastUpdateEpoch] * 2000) / DENOM <= total, "!quorum"); // at least 20% of total voting power must vote
        uint256 weightYes = (totalYes * DENOM) / total;
        uint256 weightNo = DENOM - weightYes;
        voter.voteForProposal(address(this), id, weightYes, weightNo);
        emit VoteCast(id, weightYes, weightNo);
    }

    /**
        @notice Get the current realized weight for an account
        @param _account Account to checkpoint.
        @return acctData Most recent account data written to storage.
        @return weight Most current account weight.
        @dev Prefer to use this function over it's view counterpart for
             contract -> contract interactions.
    */
    function checkpointAccount(address _account) public returns (AccountStakeData memory acctData, uint weight) {
        (acctData, weight) = _checkpointAccount(_account, getEpoch());
        accountStakeData[_account] = acctData;
    }

    /**
        @notice Checkpoint an account using a specified epoch limit.
        @dev    To use in the event that significant number of epochs have passed since last 
                heckpoint and single call becomes too expensive.
        @param _account Account to checkpoint.
        @param _epoch epoch number which we want to checkpoint up to.
        @return acctData Most recent account data written to storage.
        @return weight Account weight for provided epoch.
    */
    function checkpointAccountWithLimit(
        address _account,
        uint _epoch
    ) external returns (AccountStakeData memory acctData, uint weight) {
        uint systemEpoch = getEpoch();
        if (_epoch >= systemEpoch) _epoch = systemEpoch;
        (acctData, weight) = _checkpointAccount(_account, _epoch);
        accountStakeData[_account] = acctData;
    }

    function _checkpointAccount(
        address _account,
        uint _systemEpoch
    ) internal returns (AccountStakeData memory acctData, uint weight) {
        acctData = accountStakeData[_account];
        uint lastUpdateEpoch = acctData.lastUpdateEpoch;

        if (_systemEpoch == lastUpdateEpoch) {
            return (acctData, accountPowerAt[_account][lastUpdateEpoch]);
        }

        if (_systemEpoch <= lastUpdateEpoch) revert OldEpoch();

        uint pending = uint(acctData.pendingStake);
        uint realized = acctData.realizedStake;

        if (pending == 0) {
            if (realized != 0) {
                weight = accountPowerAt[_account][lastUpdateEpoch];
                while (lastUpdateEpoch < _systemEpoch) {
                    unchecked { lastUpdateEpoch++; }
                    accountPowerAt[_account][lastUpdateEpoch] = weight;
                }
            }
            accountStakeData[_account].lastUpdateEpoch = uint16(_systemEpoch);
            acctData.lastUpdateEpoch = uint16(_systemEpoch);
            return (acctData, weight);
        }

        weight = accountPowerAt[_account][lastUpdateEpoch];

        // Add pending to realized weight
        weight += pending;
        realized = weight;

        // Fill in any missed epochs.
        while (lastUpdateEpoch < _systemEpoch) {
            unchecked { lastUpdateEpoch++; }
            accountPowerAt[_account][lastUpdateEpoch] = weight;
        }

        // Write new account data to storage.
        acctData = AccountStakeData({
            pendingStake: 0,
            realizedStake: uint112(weight),
            magicStake: acctData.magicStake,
            lastUpdateEpoch: uint16(_systemEpoch)
        });
    }

    /**
        @notice Get the current total system weight
        @dev Also updates local storage values for total weights. Using
             this function over it's `view` counterpart is preferred for
             contract -> contract interactions.
    */
    function checkpointTotal() external returns (uint) {
        uint systemEpoch = getEpoch();
        return _checkpointTotal(systemEpoch);
    }

    /**
        @notice Get the current total system weight
        @dev Also updates local storage values for total weights. Using
             this function over it's `view` counterpart is preferred for
             contract -> contract interactions.
    */
    function _checkpointTotal(uint systemEpoch) internal returns (uint) {
        // These two share a storage slot.
        uint16 lastUpdateEpoch = totalLastUpdateEpoch;
        uint pending = totalPending;

        uint weight = totalPowerAt[lastUpdateEpoch];

        if (lastUpdateEpoch == systemEpoch) {
            return weight;
        }

        totalLastUpdateEpoch = uint16(systemEpoch);
        weight += pending;
        totalPending = 0;

        while (lastUpdateEpoch < systemEpoch) {
            unchecked { lastUpdateEpoch++; }
            totalPowerAt[lastUpdateEpoch] = weight;
        }

        return weight;
    }

    // ------------------------------------------------------------------------
    // USER WEIGHTING
    // ------------------------------------------------------------------------
    /**
     * @notice Claim any magic pounder share difference and sync strategy balances
     * @dev Unclaimed shares earn compounder yield and do not contribute to other strategies
     */
    function syncAccount() external {
        require(unclaimedMagicTokens(msg.sender) > 0, "0");
        checkpointAccount(msg.sender);
        uint systemEpoch = getEpoch();
        _checkpointTotal(systemEpoch);
        // claim any magic pounder share difference
        _syncMagicBalance(msg.sender);
        // change user strategy balances to reflect any yield
        _syncAccount(msg.sender);
    }

    function setWeights(uint112[] memory _weights) public {
        AccountWeightData memory weightData = accountWeightData[msg.sender];
        uint systemEpoch = getEpoch();
        // can only change weights once per epoch
        require(weightData.lastUpdateEpoch < systemEpoch, "!epoch");
        uint256 stratLength = strategies.length;
        require(stratLength == _weights.length, "!length");

        uint256 weightTotal;
        for (uint256 i = 0; i < stratLength; ++i) {
            weightTotal += _weights[i];
        }
        // Verify user has correct total weight
        require(weightTotal == DENOM, "!totalWeight");

        accountWeightData[msg.sender] = AccountWeightData({
            weights: _weights,
            lastUpdateEpoch: uint16(systemEpoch)
        });
        checkpointAccount(msg.sender);
        _checkpointTotal(systemEpoch);
        _syncMagicBalance(msg.sender);
        _syncAccount(msg.sender);

        emit SetWeights(msg.sender, _weights);
    }

    // -------------------------
    // INTERNAL WEIGHTING HELPERS
    // -------------------------
    /* set all user strategy balances according to balance and weights
       balances are set on psuedo-staking contracts */
    function _syncAccount(address _account) internal {
        uint256 assignedBalance;
        uint112 assignedWeight;
        uint256 accountBalance = balanceOf(_account);
        uint256 stratLength = strategies.length;
        uint112[] memory accountWeights = accountWeightData[_account].weights;
        uint256 userLength = accountWeights.length;

        // one-time user weight array extension - audit issue #21
        // gas-efficient approach, only loads as storage for effected users, and corrects weight array length for future operations
        if(userLength < stratLength) {
            // extend weights with 0s if user has no weights set for new strategies
            uint112[] storage accountWeightsStorage = accountWeightData[_account].weights;
            for (uint256 i = userLength; i < stratLength; ++i) {
                accountWeightsStorage.push(0);
            }
            // Reload memory with extended array
            accountWeights = accountWeightsStorage;
        }

        for (uint256 i = 0; i < stratLength; ++i) {
            uint112 weight = accountWeights[i];
            if(weight == 0) {
                _setUserStrategyBalance(strategies[i], _account, 0);
            } else if(accountBalance == 0) {
                assignedWeight+=weight;
                _setUserStrategyBalance(strategies[i], _account, 0);
            } else if (assignedWeight + weight == DENOM) {
                // last strategy, assign all remaining balance to avoid rounding issues
                uint256 amount = accountBalance - assignedBalance;
                _setUserStrategyBalance(strategies[i], _account, amount);
                assignedBalance += amount;
                assignedWeight += weight;
            } else {
                uint256 amount = (accountBalance * weight) / DENOM;
                _setUserStrategyBalance(strategies[i], _account, amount);
                assignedBalance += amount;
                assignedWeight += weight;
            }
        }
        require(assignedBalance <= accountBalance, "!bal");
        require(assignedWeight == DENOM, "!weight");
    }

    // checks starting balance first to avoid unneeded write calls
    function _setUserStrategyBalance(address _strategy, address _account, uint256 _amount) internal {
        Strategy strategy = Strategy(_strategy);
        if (strategy.balanceOf(_account) == _amount) {
            return;
        } else {
            strategy.setUserBalance(_account, _amount);
            if (_strategy == strategies[0]) {
                accountStakeData[_account].magicStake = uint112(Strategy(_strategy).balanceOf(_account));
            }
        }
    }

    function _syncMagicBalance(address _account) internal {
        // if user has unclaimed magic balance, adjust
        uint256 userMagic = accountStakeData[_account].magicStake;
        uint256 currentMagicBalance = Strategy(strategies[0]).balanceOf(_account);
        if (currentMagicBalance > userMagic) {
            uint256 diff = (currentMagicBalance - userMagic);
            accountStakeData[_account].pendingStake += uint112(diff);
            accountStakeData[_account].magicStake = uint112(currentMagicBalance);
            accountStakeData[_account].lastUpdateEpoch = uint16(getEpoch());
            totalPending += uint112(diff);
            emit MagicClaim(_account, diff);
        }
    }

    // ------------------------------------------------------------------------
    // USER STAKE FUNCTIONS
    // ------------------------------------------------------------------------
    /**
     * @notice Stake RSUP
     * @dev Voting ability may be delayed by 1 epoch if significantly increasing stake
     * @param _amount Amount of RSUP to stake
     */
    function stake(uint256 _amount) external {
        require(!paused, "paused");
        uint systemEpoch = getEpoch();
        require(_amount > 0, "0");
        // Make sure weights are set first, for account syncing
        require(accountWeightData[msg.sender].lastUpdateEpoch != 0, "!weights");



        RSUP.safeTransferFrom(msg.sender, address(this), _amount);
        staker.stake(_amount); // only stake the requested amount, since contract may contain cooldown RSUP
        totalSupply += _amount;
        
        (AccountStakeData memory acctData, ) = _checkpointAccount(msg.sender, systemEpoch);
        _checkpointTotal(systemEpoch);

        acctData.pendingStake += uint112(_amount);
        totalPending += uint112(_amount);

        accountStakeData[msg.sender] = acctData;
        _syncMagicBalance(msg.sender);
        // change user strategy balances to reflect additional stake
        _syncAccount(msg.sender);
        emit Stake(msg.sender, systemEpoch, _amount);
    }

    /**
     * @notice Enter cooldown for RSUP unstake
     * @dev Can only be performed every (cooldownEpochs + 1) epochs
     * @param _amount Amount of RSUP to cooldown
     */
    function cooldown(uint256 _amount) external {
        uint256 cde = staker.cooldownEpochs();
        uint systemEpoch = getEpoch();
        uint256 coolPeriod = cde + 1;
        uint256 nextCoolPeriod = systemEpoch + coolPeriod;

        /* verify it is an eligible cooldown epoch
           this can change if staker changes cooldownEpochs
           will always be set to 1 epoch greater than staker cooldownEpochs
           Example: cooldown is 2 weeks, can only initiate cooldowns during every 3rd week */
        require(systemEpoch % coolPeriod == 0, "!epoch");

        if (_amount == 0 || _amount > type(uint112).max) revert InvalidAmount();

        // psuedo-claim any magic pounder share difference
        (AccountStakeData memory acctData, ) = _checkpointAccount(msg.sender, systemEpoch);
        if (acctData.realizedStake < _amount) revert InsufficientRealizedStake();
        _checkpointTotal(systemEpoch);

        /* check if user has previous matured cooldowns
           there is a rare edge case where if underyling staker increases cooldownEpochs,
           and new cooldowns are inititated by other users before the first cooldown period is reached,
           a user's cooldown may be locked until the new cooldown epoch is reached
           theoretical total cooldown length: original cooldownEpoch + new cooldownEpoch - 1 */
        if (accountCooldownData[msg.sender].amount > 0 && accountCooldownData[msg.sender].maturityEpoch <= systemEpoch) {
            _unstake();
        }

        // check if existing matured community cooldowns need unstaked first
        if (pendingCooldownEpoch <= systemEpoch) {
            _rsupUnstake();
            pendingCooldownEpoch = nextCoolPeriod;
        } else if (pendingCooldownEpoch == type(uint256).max) {
            // if no pending cooldown, set pendingCooldownEpoch to next cooldown epoch
            pendingCooldownEpoch = nextCoolPeriod;
        } else if (pendingCooldownEpoch != nextCoolPeriod) {
            // If pendingCooldownEpoch is out of sync with nextCoolPeriod,
            // there has been a change to cooldownEpochs in staker contract
            // cooldowns are locked until previous maturity is reached - audit issue #22
            revert CooldownsPending();
        }

        // Remove from balances, supply
        acctData.realizedStake -= uint112(_amount);
        accountStakeData[msg.sender] = acctData;
        // totalPowerAt[systemEpoch] -= _amount; // Removed to prevent changing quorum mid-epoch
        accountPowerAt[msg.sender][systemEpoch] -= _amount;
        totalSupply -= _amount;

        // Add to user cooldown balance
        accountCooldownData[msg.sender].amount += _amount;

        // Set user cooldown maturity epoch
        accountCooldownData[msg.sender].maturityEpoch = pendingCooldownEpoch;

        // call staker cooldown
        staker.cooldown(address(this), _amount);

        // change user strategy balances to reflect decreased balance
        _syncMagicBalance(msg.sender);
        _syncAccount(msg.sender);
        emit Cooldown(msg.sender, _amount);
    }

    /**
     * @notice Unstake matured cooldown RSUP
     * @dev Must wait for full cooldownEpochs to pass before unstaking
     */
    function unstake() public {
        require(accountCooldownData[msg.sender].amount > 0, "0");
        require(accountCooldownData[msg.sender].maturityEpoch <= getEpoch(), "!epoch");
        _unstake();
    }

    // ------------------------------------------------------------------------
    // INTERNAL STAKE HELPERS
    // ------------------------------------------------------------------------
    function _unstake() internal {
        if (pendingCooldownEpoch <= getEpoch()) {
            _rsupUnstake();
            pendingCooldownEpoch = type(uint256).max;
        }
        uint256 amount = accountCooldownData[msg.sender].amount;
        accountCooldownData[msg.sender].amount = 0;
        RSUP.safeTransfer(msg.sender, amount);
        emit Unstake(msg.sender, amount);
    }

    function _rsupUnstake() internal {
        uint256 amount = staker.unstake(address(this), address(this));
        require(amount > 0, "!rsupUnstake");
    }

    // ------------------------------------------------------------------------
    // REWARDS HARVESTING
    // ------------------------------------------------------------------------
    /**
     * @notice Harvest rewards
     * @dev Rewards are divided among strategies.
     */
    function harvest() external {
        // claim all rewards from staker
        staker.getReward(address(this));

        address[10] memory positiveRewards;
        uint256[10] memory rewardBals;
        uint256 rewLength = rewards.length;
        uint256 stratLength = strategies.length;
        // give caller their cut of all rewards
        for (uint256 r = 0; r < rewLength; ++r) {
            uint256 rewardBal = rewards[r].balanceOf(address(this));
            // if no rewards, skip
            if (rewardBal == 0) {
                continue;
            }
            // give caller their cut
            uint256 callerFee = (rewardBal * CALL_FEE) / DENOM;
            rewards[r].safeTransfer(msg.sender, callerFee);
            positiveRewards[r] = address(rewards[r]);
            rewardBals[r] = rewardBal - callerFee;
            emit Harvest(address(rewards[r]), rewardBals[r]);
        }

        // distribute rewards to strategies based on their assigned balance
        uint256 staticSupply = totalSupply;
        for (uint256 i = 0; i < stratLength; ++i) {
            address strategy = strategies[i];
            uint256 stratSupply = Strategy(strategy).totalSupply();
            if (stratSupply == 0) {
                continue;
            }
            require(strategyHarvester[strategy] != address(0), "!harvester");
            uint256[10] memory stratShares;
            for (uint256 r = 0; r < rewLength; ++r) {
                if(positiveRewards[r] == address(0)) {
                    continue;
                }
                if(i == stratLength - 1) {
                    // last strategy, assign all remaining shares to avoid rounding issues
                    uint256 lastRewardBal = rewards[r].balanceOf(address(this));
                    stratShares[r] = lastRewardBal;
                    continue;
                }
                stratShares[r] = (rewardBals[r] * stratSupply) / staticSupply;
            }
            // process rewards for strategy
            Harvester(strategyHarvester[strategy]).process(positiveRewards, stratShares, strategy);
        }
    }

    // ------------------------------------------------------------------------
    // MAGIC FUNCTIONS
    // ------------------------------------------------------------------------
    function magicStake(uint256 _amount) external {
        require(!paused, "paused");
        require(msg.sender == strategies[0], "!magic");
        RSUP.safeTransferFrom(strategies[0], address(this), _amount);
        staker.stake(_amount);
        totalSupply += _amount;
        emit MagicStake(_amount);
    }

    // ------------------------------------------------------------------------
    // MANAGER FUNCTIONS
    // ------------------------------------------------------------------------

    // Add reward token
    function addRewardToken(address _rewardToken) external onlyManager {
        require(_rewardToken != address(RSUP), "!rsup"); // audit issue #14
        require(_rewardToken != address(0), "!zeroAddress");
        require(rewards.length < 10, "!maxRewards");
        require(!isRewardToken[_rewardToken], "!exists");
        isRewardToken[_rewardToken] = true;
        rewards.push(IERC20(_rewardToken));

        // Approve to all unique harvesters (audit issue #19)
        uint256 stratLength = strategies.length;
        address[] memory approvedHarvesters = new address[](stratLength);
        uint256 approvedCount;
        
        for (uint256 i = 0; i < stratLength; ++i) {
            address harvester = strategyHarvester[strategies[i]];
            if (harvester == address(0)) continue;
            
            // Check if already approved
            bool alreadyApproved;
            for (uint256 j = 0; j < approvedCount; ++j) {
                if (approvedHarvesters[j] == harvester) {
                    alreadyApproved = true;
                    break;
                }
            }
            
            if (!alreadyApproved) {
                IERC20(_rewardToken).forceApprove(harvester, type(uint256).max);
                approvedHarvesters[approvedCount] = harvester;
                approvedCount++;
            }
        }

        emit NewRewardToken(_rewardToken);
    }

    // Remove reward token
    function removeRewardToken(uint256 _rewardIndex, address _rewardToken) external onlyManager {
        require(address(rewards[_rewardIndex]) == _rewardToken, "!mismatchId");
        isRewardToken[_rewardToken] = false;
        // replace index with last index
        rewards[_rewardIndex] = rewards[rewards.length - 1];
        rewards.pop();

        // Revoke approvals from all unique harvesters (audit issue #19)
        uint256 stratLength = strategies.length;
        address[] memory revokedHarvesters = new address[](stratLength);
        uint256 revokedCount;
        
        for (uint256 i = 0; i < stratLength; ++i) {
            address harvester = strategyHarvester[strategies[i]];
            if (harvester == address(0)) continue;
            
            // Check if already revoked
            bool alreadyRevoked;
            for (uint256 j = 0; j < revokedCount; ++j) {
                if (revokedHarvesters[j] == harvester) {
                    alreadyRevoked = true;
                    break;
                }
            }
            
            if (!alreadyRevoked) {
                IERC20(_rewardToken).forceApprove(harvester, 0);
                revokedHarvesters[revokedCount] = harvester;
                revokedCount++;
            }
        }
        emit RemoveRewardToken(_rewardToken);
    }

    // set call fee
    function setCallFee(uint256 _fee) external onlyManager {
        require(_fee <= MAX_CALL_FEE, "!max");
        CALL_FEE = _fee;
        emit CallFeeSet(_fee);
    }

    // ------------------------------------------------------------------------
    // Operator FUNCTIONS
    // ------------------------------------------------------------------------

    // Pause new RSUP stakes
    function setPaused(bool _paused) external onlyOperator {
        paused = _paused;
    }

    // Set strategy harvester
    function setStrategyHarvester(address _strategy, address _harvester, bool _keepOldApproval) external onlyOperator {
        // validate harvester has route for strategy desired tokens
        for(uint256 i = 0; i<rewards.length; ++i) {
            Harvester.Route[] memory routes = Harvester(_harvester).getRoute(address(rewards[i]), Strategy(_strategy).desiredToken());
            require(routes.length > 0, "!route");
        }
        // since strategies can share harvester, make it a choice to revoke old permissions or not
        // this way, changing harvester for 1 strategy doesn't break another
        if(!_keepOldApproval) {
            address oldHarvester = strategyHarvester[_strategy];
            if(oldHarvester != address(0)) {
                for(uint256 i = 0; i<rewards.length; ++i) {
                    rewards[i].forceApprove(oldHarvester, 0);
                }
            }
        }
        strategyHarvester[_strategy] = _harvester;
        for(uint256 i = 0; i<rewards.length; ++i) {
            rewards[i].forceApprove(_harvester, type(uint256).max);
        }
        emit StrategyHarvesterSet(_strategy, _harvester);
    }

    // Add strategy
    function addStrategy(address _strategy) external onlyOperator {
        // Strategy must allow this contract to set user balances
        // Ensuring functionality/safety of strategy is outside of this scope
        // But this function is essential to THIS contract not breaking

        require(isStrategy[_strategy] == false, "exists"); // Audit issue #25

        Strategy strategy = Strategy(_strategy);

        // Verify strategy has a desiredToken and that it is not RSUP
        address dt = strategy.desiredToken();
        require(dt != address(0) && dt != address(RSUP), "!desiredToken");

        // Verify adding balance
        strategy.setUserBalance(address(1234), DENOM);
        require(strategy.balanceOf(address(1234)) == DENOM, "!balance1");
        require(strategy.totalSupply() == DENOM, "!supply1");

        // Verify removing balance
        strategy.setUserBalance(address(1234), 0);
        require(strategy.balanceOf(address(1234)) == 0, "!balance0");
        require(strategy.totalSupply() == 0, "!supply0");

        strategies.push(_strategy);
        isStrategy[_strategy] = true; // Audit issue #25

        emit StrategyAdded(_strategy);
    }

    // Set magic voter
    function setMagicVoter(address _magicVoter) external onlyOperator {
        magicVoter = _magicVoter;
        emit MagicVoterSet(_magicVoter);
    }

    function isValidVoter(address _voter) internal view returns (bool) {
        if(_voter == address(0)) {
            return false;
        }
        if (_voter.code.length == 0) {
            return false;
        }
        try Voter(_voter).minCreateProposalWeight() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }
    // Set Resupply voter contract
    function setResupplyVoter() external onlyOperator {
        address _voter = REGISTRY.getAddress("VOTER");
        require(isValidVoter(_voter), "!voter");
        voter = Voter(_voter);
        MagicVoter(magicVoter).setResupplyVoter(_voter);
        emit ResupplyVoterSet(_voter);
    }

    // Migrate Resupply staker contract (audit issue #20)
    /**
     * @notice DAO restricted migration function for Resupply staker contract in the event of an upgrade
     * @dev Requires native cooldownEpochs to be set to 0 for an atomic migration
     * @dev Requires account pending stake to be 0 and new stakes to be paused
     */
    function migrateStaker() external {
        require(msg.sender == RESUPPLY_CORE, "!auth");
        require(paused, "!paused");
        require(staker.cooldownEpochs() == 0, "!cooldown");

        Staker.AccountData memory data = staker.accountData(address(this));
        require(data.pendingStake == 0 || data.lastUpdateEpoch < getEpoch(), "!pending");

        // use exit function to claim rewards and cooldown all staked RSUP
        staker.exit(address(this));
        
        // since unstaked amount may include already pending cooldowns, we cannot re-stake the entire amount
        // totalSupply should reflect all desired staked RSUP
        staker.unstake(address(this), address(this));

        // update staker address
        address _staker = REGISTRY.getAddress("STAKER");
        require(_staker.code.length > 0, "!staker");
        staker = Staker(_staker);

        // stake totalSupply to new staker
        staker.stake(totalSupply);

        // reflect that pending cooldowns have been unstaked
        pendingCooldownEpoch = type(uint256).max;
    }

    /**
     * @notice Fallback in case migration is not atomic
     * @dev Requires manual migration to be already be completed
     * @dev Requires new stakes to be paused and old staker to have 0 pending and realized stake for this contract to prevent balance corruption
     */
    function manualSetStaker() external {
        require(msg.sender == RESUPPLY_CORE, "!auth");
        require(paused, "!paused");
        // verify old staker has been fully exited (does not check rewards)
        Staker.AccountData memory data = staker.accountData(address(this));
        require(data.pendingStake == 0 && data.realizedStake == 0, "!stake");

        // update staker address
        address _staker = REGISTRY.getAddress("STAKER");
        require(_staker.code.length > 0, "!staker");
        staker = Staker(_staker);

        // verify new staker has correct amount staked
        // if failure due to rounding, can be resolved by staking a small amount on behalf of unofficial staker
        // prevents a bad migration from corrupting contract states
        data = staker.accountData(address(this));
        uint256 stakedAmount = data.pendingStake + data.realizedStake;
        require(stakedAmount >= totalSupply, "!supplyParity");
    }

    // Set delegate approval for voter contract
    function setDelegateApproval(address _delegate, bool _isApproved) external onlyOperator {
        voter.setDelegateApproval(_delegate, _isApproved);
        emit DelegateApprovalSet(_delegate, _isApproved);
    }   

    // Fallback executable function
    function execute(
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external onlyOperator returns (bool, bytes memory) {
        require(msg.sender == RESUPPLY_CORE, "!auth");
        (bool success, bytes memory result) = _to.call{value: _value}(_data);
        require(success, "execute failed");
        emit Executed(_to, _value, _data, success);
        return (success, result);
    }
}