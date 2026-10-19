// SPDX-License-Identifier: MIT

/*

    usRSUP - transferable, auto-compounding vault token on top of magicStaker.

    You should personally audit and test this code before using it.

    - The vault is a single magicStaker account weighted 100% to the magic pounder (strategy 0).
    - Deposits: RSUP is staked 1:1 into magicStaker, or partially routed through the usRSUP/RSUP Curve pool
      when the pool pays more than minting (depositWithRoute).
    - Withdrawals: sell on Curve (withdrawViaCurve), or schedule an async withdrawal (requestWithdraw)
      which is cooled down in magicStaker immediately if made in a cooldown week the vault can use (canCooldown),
      otherwise in the next cooldown week, and claimed after maturity. A cooldown-week request that can't be cooled
      immediately joins the overflow batch, cooled later that week or in the next cooldown week.
    - Yield is recorded as locked profit and unlocked gradually: each new profit unlocks over PROFIT_UNLOCK_PERIOD,
      blended (amount-weighted) with any profit still unlocking, so the share price (which the Curve pool uses as its
      rate oracle) never jumps.
    - usRSUP holders have no voting power. Apart from the owner's execute escape hatch, the vault's magicStaker
      weight can only be used by boostQuorum, which mirrors the existing yes/no split of magicStaker voters once
      they reach an adjustable quorum measured excluding the vault's own weight.

*/

pragma solidity ^0.8.30;

import { IERC20, SafeERC20 } from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import { ERC20 } from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import { ERC4626 } from '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol';
import { ReentrancyGuard } from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import { Math } from '@openzeppelin/contracts/utils/math/Math.sol';
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

interface IMagicStaker {
    function stake(uint256 _amount) external;
    function cooldown(uint256 _amount) external;
    function unstake() external;
    function setWeights(uint112[] memory _weights) external;
    function syncAccount() external;
    function harvest() external;
    function rewardsLength() external view returns (uint256);
    function rewards(uint256 _index) external view returns (address);
    function checkpointTotal() external returns (uint256);
    function balanceOf(address _account) external view returns (uint256);
    function unclaimedMagicTokens(address _account) external view returns (uint256);
    function accountStakeData(address _account) external view returns (uint112 realizedStake, uint112 pendingStake, uint112 magicStake, uint16 lastUpdateEpoch);
    function accountCooldownData(address _account) external view returns (uint256 amount, uint256 maturityEpoch);
    function strategiesLength() external view returns (uint256);
    function strategies(uint256 _index) external view returns (address);
    function staker() external view returns (address);
    function magicVoter() external view returns (address);
    function pendingCooldownEpoch() external view returns (uint256);
    function paused() external view returns (bool);
    function getEpoch() external view returns (uint256);
    function totalPowerAt(uint256 _epoch) external view returns (uint256);
    function getVotingPowerAt(address _account, uint256 _epoch) external view returns (uint256);
}

interface IRsupStaker {
    function cooldownEpochs() external view returns (uint256);
}

interface IMagicVoter {
    function voter() external view returns (address);
    function canVote(uint256 id) external view returns (bool _canVote, uint32 _createdAt, uint256 _delay);
    function timeToEpoch(uint256 timestamp) external pure returns (uint256);
    function voteTotals(address voter, uint256 id) external view returns (uint256 yes, uint256 no);
    function executed(address voter, uint256 id) external view returns (bool);
    function vote(uint256 id, uint256 pctYes, uint256 pctNo) external;
}

interface ICurvePool {
    function coins(uint256 i) external view returns (address);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) external returns (uint256);
}

contract usRSUP is ERC4626, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------
    // STRUCTS
    // ------------------------------------------------------------------------

    // A withdrawal slot. Accumulates requests until cooled down, then becomes a claimable batch.
    struct Batch {
        uint128 owed; // RSUP owed to all requests in this batch
        uint128 fees; // withdraw fees (RSUP) collected from requests in this batch
        uint64 maturityEpoch; // 0 until cooled
    }

    // ------------------------------------------------------------------------
    // VARIABLES
    // ------------------------------------------------------------------------

    // Constants
    uint256 public constant DENOM = 10000;
    uint256 public constant PROFIT_UNLOCK_PERIOD = 7 days;
    uint256 public constant MAX_WITHDRAW_FEE = 100; // 1 %
    uint256 public constant MAX_MEV_CAP = 1000e18; // 1000 usRSUP
    uint256 public constant MAX_FEE_CAP = 1000e18; // 1000 usRSUP
    uint256 public constant MIN_BOOST_QUORUM = 500; // 5 %
    uint256 public constant MAX_BOOST_QUORUM = 2000; // 20 %, magicStaker's own quorum
    uint256 public constant MAX_BOOST_DELAY = 7 days;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IMagicStaker public immutable magicStaker;

    // Curve pool (set once)
    ICurvePool public curvePool;
    int128 public poolRsupIndex;
    int128 public poolTokenIndex;

    // Owner parameters
    uint256 public withdrawFee = 10; // 0.1 %
    uint256 public feeCap = 25e18; // max withdraw fee per request, in usRSUP (charged as its RSUP value). 0 means no fee.
    uint256 public mevCap = 100e18; // max keeper reward per processBacklog call, in usRSUP. 0 means no keeper reward.
    uint256 public boostQuorumBps = 1000; // 10 % of non-vault voting power
    uint256 public boostDelay; // seconds after proposal creation before boost is allowed (on top of magicVoter delay)
    bool public boostEnabled = true; // the owner can switch the quorum boost off entirely

    // System
    bool public initialized;
    bool public paused; // pauses deposits only

    // Accounting (all in RSUP)
    uint256 public recordedStake; // vault stake in magicStaker as of last sync (balance + unclaimed pounder yield)
    uint256 public lockedProfitStored; // locked profit as of lastProfitUpdate
    uint256 public lastProfitUpdate;
    uint256 public fullUnlockTime; // locked profit unlocks linearly from lastProfitUpdate until this time; the schedule is re-blended whenever profit is added
    uint256 public backlogOwed; // RSUP owed to queued (not yet cooled) withdrawals, still staked
    uint256 public feePot; // withdraw fees of queued withdrawals, still staked, excluded from totalAssets

    // Withdrawal queue
    uint256 public nextBatchId = 1;
    uint256 public pendingBatchId; // requests processed at the next cooldown epoch
    uint256 public overflowBatchId; // cooldown-epoch requests that couldn't be cooled when made; 0 if none
    // The overflow batch can be cooled only in epochs after this one. Set to the current epoch when a request that
    // doesn't fit behind the queue joins it, and to the previous epoch when a batch is created by a magicStaker
    // rejection of a request that does fit, so it is coolable at once.
    uint256 public overflowEpoch;
    mapping(uint256 id => Batch) public batches;
    mapping(address account => mapping(uint256 id => uint256 owed)) public requestOf;
    // Batches with requestOf > 0 (unclaimed). Only the account adds to its own set; claims remove in constant time.
    // Full request history is in the WithdrawRequested / WithdrawClaimed events.
    mapping(address account => uint256[] ids) internal _activeBatchIds;
    mapping(address account => mapping(uint256 id => uint256 position)) internal _activeIndex; // index in _activeBatchIds + 1

    // ------------------------------------------------------------------------
    // EVENTS
    // ------------------------------------------------------------------------
    event Initialized(uint256 seedAssets);
    event RoutedDeposit(address indexed caller, address indexed receiver, uint256 assets, uint256 swapped, uint256 sharesFromSwap, uint256 sharesMinted);
    event CurveWithdraw(address indexed owner, address indexed receiver, uint256 shares, uint256 assets);
    event WithdrawRequested(address indexed account, uint256 indexed batchId, uint256 shares, uint256 owed, uint256 fee);
    event BatchCooled(uint256 indexed batchId, uint256 owed, uint256 maturityEpoch);
    /// @dev caller is address(0) when a cooldown-week requestWithdraw processes the backlog (no keeper reward)
    event BacklogProcessed(address indexed caller, uint256 amount, uint256 fees, uint256 keeperShares);
    event WithdrawClaimed(address indexed account, address indexed receiver, uint256 indexed batchId, uint256 assets);
    /// @dev emitted for both staking yield and withdraw-fee income
    event ProfitRecorded(uint256 profit, uint256 lockedProfit);
    event LossRecorded(uint256 loss);
    event QuorumBoosted(uint256 indexed proposalId, uint256 pctYes, uint256 pctNo, uint256 vaultPower);
    event CurvePoolSet(address pool);
    event PausedSet(bool paused);
    event WithdrawFeeSet(uint256 fee);
    event MevCapSet(uint256 cap);
    event FeeCapSet(uint256 cap);
    event BoostQuorumSet(uint256 quorum);
    event BoostDelaySet(uint256 delay);
    event BoostEnabledSet(bool enabled);
    event Executed(address to, uint256 value, bytes data, bool success);
    event HarvestForwarded(address indexed caller, address indexed rewardToken, uint256 amount);

    // ------------------------------------------------------------------------
    // ERRORS
    // ------------------------------------------------------------------------
    error NotInitialized();
    error DepositsPaused();
    error ZeroAmount();
    error AsyncWithdrawOnly();
    error Slippage();
    error NoPool();
    error NotCooldownEpoch();
    error NothingToProcess();
    error NotClaimable();
    error QuorumNotMet();
    error BoostTooEarly();
    error NotCommitted();
    error InvalidParam();
    error ZeroAddress();
    error BoostDisabled();
    error RenounceDisabled();

    // ------------------------------------------------------------------------
    // CONSTRUCTOR
    // ------------------------------------------------------------------------
    /**
     * @param _magicStaker Deployed magicStaker (mainnet: 0x64199056cAFF992227ff7c6f544F238b65141990)
     * @dev The deployer is owner until transferring ownership to Resupply governance (see usRSUP.md).
     */
    constructor(address _magicStaker)
        ERC20("Unofficial Staked RSUP", "usRSUP")
        ERC4626(IERC20(0x419905009e4656fdC02418C7Df35B1E61Ed5F726))
        Ownable(msg.sender)
    {
        require(_magicStaker != address(0), "!zeroAddress");
        magicStaker = IMagicStaker(_magicStaker);
        require(magicStaker.strategies(0) != address(0), "!pounder");

        // 100% weight to the magic pounder. New strategies added later are auto-extended with 0 weight.
        uint256 stratLength = magicStaker.strategiesLength();
        uint112[] memory weights = new uint112[](stratLength);
        weights[0] = uint112(DENOM);
        magicStaker.setWeights(weights);

        pendingBatchId = nextBatchId++;
    }


    // ------------------------------------------------------------------------
    // VIEWS
    // ------------------------------------------------------------------------

    /**
     * @notice RSUP backing outstanding shares, excluding queued withdrawals, fees and locked profit
     * @dev Uses recorded values only, never live pounder balances, so it cannot jump within a block
     */
    function totalAssets() public view override returns (uint256) {
        uint256 excluded = backlogOwed + feePot + lockedProfit();
        return recordedStake > excluded ? recordedStake - excluded : 0;
    }

    /// @notice RSUP per 1e18 usRSUP. Same value the Curve pool reads via convertToAssets (asset type 3).
    function pricePerShare() external view returns (uint256) {
        return convertToAssets(1e18);
    }

    function lockedProfit() public view returns (uint256) {
        uint256 end = fullUnlockTime;
        if (block.timestamp >= end) return 0;
        return (lockedProfitStored * (end - block.timestamp)) / (end - lastProfitUpdate);
    }

    /// @notice Stake the vault currently holds in magicStaker, including un-synced pounder yield
    function currentStake() public view returns (uint256) {
        return magicStaker.balanceOf(address(this)) + magicStaker.unclaimedMagicTokens(address(this));
    }

    /// @notice Realized stake available to enter cooldown this epoch
    function availableToCooldown() public view returns (uint256) {
        (uint112 realized, uint112 pending,, uint16 lastUpdateEpoch) = magicStaker.accountStakeData(address(this));
        if (lastUpdateEpoch < magicStaker.getEpoch()) return uint256(realized) + pending;
        return realized;
    }

    /// @notice Whether magicStaker's cooldown schedule currently allows a cooldown from this vault. It does not check
    ///         stake, or whether magicStaker would reject the cooldown for another reason.
    function canCooldown() public view returns (bool) {
        uint256 cde = IRsupStaker(magicStaker.staker()).cooldownEpochs();
        uint256 epoch = magicStaker.getEpoch();
        if (epoch % (cde + 1) != 0) return false;
        uint256 next = epoch + cde + 1;
        // magicStaker reverts with CooldownsPending if its global maturity is out of sync
        uint256 pce = magicStaker.pendingCooldownEpoch();
        if (pce != type(uint256).max && pce > epoch && pce != next) return false;
        // never re-date an unmatured vault cooldown to a different maturity
        (uint256 amount, uint256 maturity) = magicStaker.accountCooldownData(address(this));
        if (amount > 0 && maturity > epoch && maturity != next) return false;
        return true;
    }

    /// @notice Batches the account still has RSUP to claim from (queued, cooling down, or claimable)
    function accountActiveBatchIds(address _account) external view returns (uint256[] memory) {
        return _activeBatchIds[_account];
    }

    /**
     * @notice Epoch from which a batch is expected to be claimable (0 for an unknown or empty batch)
     * @dev Firm once the batch has entered cooldown (its maturity). While queued it is an estimate that assumes the
     *      batch is processed in the first cooldown epoch it is eligible for; it moves later if nobody processes it
     *      then, if magicStaker rejects the cooldown, if a later cooldown-week request pushes the overflow batch back,
     *      or if magicStaker's cooldown schedule changes. Epoch N starts at 1741824000 + N * 604800.
     */
    function estimatedClaimEpoch(uint256 _batchId) external view returns (uint256) {
        Batch memory b = batches[_batchId];
        if (b.maturityEpoch != 0) return b.maturityEpoch;
        if (b.owed == 0) return 0;
        uint256 cde = IRsupStaker(magicStaker.staker()).cooldownEpochs();
        uint256 period = cde + 1;
        uint256 epoch = magicStaker.getEpoch();
        // the overflow batch can only be cooled in epochs after overflowEpoch
        uint256 earliest = epoch;
        if (_batchId == overflowBatchId && overflowEpoch + 1 > earliest) earliest = overflowEpoch + 1;
        uint256 next = ((earliest + period - 1) / period) * period;
        if (next == epoch && !_processableNow(_batchId)) next += period;
        return next + period;
    }

    /// @dev Whether _processBacklog would cool this queued batch if called now (same checks, same order)
    function _processableNow(uint256 _batchId) internal view returns (bool) {
        if (!canCooldown()) return false;
        if (_batchId == overflowBatchId && overflowEpoch >= magicStaker.getEpoch()) return false;
        uint256 available = availableToCooldown();
        uint256 pendingOwed = batches[pendingBatchId].owed;
        if (_batchId == pendingBatchId) return pendingOwed <= available;
        if (_batchId != overflowBatchId) return false;
        // overflow is considered after the pending batch
        if (pendingOwed <= available) available -= pendingOwed;
        return batches[_batchId].owed <= available;
    }

    /**
     * @notice RSUP claimable now by an account for a batch (0 if not matured)
     * @dev Assumes magicStaker releases the vault's matured cooldown during claim, which claim() does itself.
     *      Use batchReleased() to see whether a matured batch's RSUP is already held by the vault.
     */
    function claimable(address _account, uint256 _batchId) public view returns (uint256) {
        uint256 maturity = batches[_batchId].maturityEpoch;
        if (maturity == 0 || maturity > magicStaker.getEpoch()) return 0;
        return requestOf[_account][_batchId];
    }

    /// @notice Whether a matured batch's RSUP has already been released from magicStaker into the vault
    function batchReleased(uint256 _batchId) external view returns (bool) {
        uint64 maturity = batches[_batchId].maturityEpoch;
        if (maturity == 0 || maturity > magicStaker.getEpoch()) return false;
        (uint256 heldAmount, uint256 heldMaturity) = magicStaker.accountCooldownData(address(this));
        return heldAmount == 0 || heldMaturity != maturity;
    }

    // ERC4626: withdrawals are async only
    function maxWithdraw(address) public pure override returns (uint256) { return 0; }
    function maxRedeem(address) public pure override returns (uint256) { return 0; }
    function previewWithdraw(uint256) public pure override returns (uint256) { revert AsyncWithdrawOnly(); }
    function previewRedeem(uint256) public pure override returns (uint256) { revert AsyncWithdrawOnly(); }
    function withdraw(uint256, address, address) public pure override returns (uint256) { revert AsyncWithdrawOnly(); }
    function redeem(uint256, address, address) public pure override returns (uint256) { revert AsyncWithdrawOnly(); }

    function maxDeposit(address) public view override returns (uint256) {
        if (!initialized || paused || magicStaker.paused()) return 0;
        return type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        if (!initialized || paused || magicStaker.paused()) return 0;
        return type(uint256).max;
    }

    // ------------------------------------------------------------------------
    // DEPOSITS
    // ------------------------------------------------------------------------

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        _sync(false);
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        _sync(false);
        return super.mint(shares, receiver);
    }

    /**
     * @notice Deposit RSUP, routing `_swapAmount` through Curve if it yields more usRSUP than minting
     * @dev `_swapAmount` is computed off-chain. The swap only happens if it returns more than minting would;
     *      otherwise, or with no pool set, the whole deposit is minted.
     * @param _assets Total RSUP to deposit
     * @param _swapAmount Portion of `_assets` to swap through Curve
     * @param _minSharesOut Minimum total usRSUP to receive
     * @param _receiver Recipient of usRSUP
     */
    function depositWithRoute(
        uint256 _assets,
        uint256 _swapAmount,
        uint256 _minSharesOut,
        address _receiver
    ) external nonReentrant returns (uint256 sharesOut) {
        if (!initialized) revert NotInitialized();
        if (paused) revert DepositsPaused();
        if (_assets == 0) revert ZeroAmount();
        if (_swapAmount > _assets) revert InvalidParam();
        if (_receiver == address(0)) revert ZeroAddress();

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), _assets);
        _sync(false);

        uint256 swapped;
        uint256 sharesFromSwap;
        if (_swapAmount > 0 && address(curvePool) != address(0)) {
            // a remainder worth less than one share can't be minted; swap it too
            if (_swapAmount < _assets && previewDeposit(_assets - _swapAmount) == 0) _swapAmount = _assets;
            uint256 fair = previewDeposit(_swapAmount);
            uint256 quote = curvePool.get_dy(poolRsupIndex, poolTokenIndex, _swapAmount);
            if (quote > fair) {
                // swap happens before any accounting change, so the pool reads a consistent rate.
                // RSUP is sent to the pool first, so the pool never holds an RSUP allowance from the vault.
                uint256 receiverBefore = balanceOf(_receiver);
                IERC20(asset()).safeTransfer(address(curvePool), _swapAmount);
                curvePool.exchange_received(poolRsupIndex, poolTokenIndex, _swapAmount, fair, _receiver);
                // count what the receiver actually got, not what the pool reports
                sharesFromSwap = balanceOf(_receiver) - receiverBefore;
                if (sharesFromSwap < fair) revert Slippage();
                swapped = _swapAmount;
            }
        }

        uint256 toMint = _assets - swapped;
        uint256 sharesMinted;
        if (toMint > 0) {
            sharesMinted = previewDeposit(toMint);
            _stakeAndMint(msg.sender, _receiver, toMint, sharesMinted);
        }

        sharesOut = sharesFromSwap + sharesMinted;
        if (sharesOut < _minSharesOut) revert Slippage();
        emit RoutedDeposit(msg.sender, _receiver, _assets, swapped, sharesFromSwap, sharesMinted);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (!initialized) revert NotInitialized();
        IERC20(asset()).safeTransferFrom(caller, address(this), assets);
        _stakeAndMint(caller, receiver, assets, shares);
    }

    function _stakeAndMint(address caller, address receiver, uint256 assets, uint256 shares) internal {
        if (paused) revert DepositsPaused();
        if (assets == 0 || shares == 0) revert ZeroAmount();
        // approve exactly what is staked, so magicStaker never holds a standing allowance over vault RSUP
        IERC20(asset()).forceApprove(address(magicStaker), assets);
        magicStaker.stake(assets);
        recordedStake += assets;
        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    // ------------------------------------------------------------------------
    // WITHDRAWALS
    // ------------------------------------------------------------------------

    /**
     * @notice Sell usRSUP for RSUP on Curve at market rate
     */
    function withdrawViaCurve(uint256 _shares, uint256 _minOut, address _receiver) external nonReentrant returns (uint256 assets) {
        if (address(curvePool) == address(0)) revert NoPool();
        if (_shares == 0) revert ZeroAmount();
        if (_receiver == address(0)) revert ZeroAddress();
        uint256 receiverBefore = IERC20(asset()).balanceOf(_receiver);
        _transfer(msg.sender, address(curvePool), _shares);
        curvePool.exchange_received(poolTokenIndex, poolRsupIndex, _shares, _minOut, _receiver);
        // count what the receiver actually got, not what the pool reports
        assets = IERC20(asset()).balanceOf(_receiver) - receiverBefore;
        if (assets < _minOut) revert Slippage();
        emit CurveWithdraw(msg.sender, _receiver, _shares, assets);
    }

    /**
     * @notice Schedule an async withdrawal. Shares are burned now and the RSUP owed is fixed now.
     * @dev When canCooldown() is true (a cooldown epoch the vault can use), the eligible backlog is processed first
     *      (no keeper reward), then this request is cooled immediately in its own batch if it fits
     *      availableToCooldown(). Otherwise it goes to the overflow batch. If magicStaker rejected the cooldown and the
     *      request still fits behind the batches that are cooled before it, the overflow batch stays coolable this
     *      epoch once magicStaker recovers (unless an earlier request this epoch already made it wait). Otherwise the
     *      overflow batch waits for the next cooldown epoch. When canCooldown() is false the request joins the pending
     *      batch. Never reverts on a magicStaker cooldown failure. Requests are always recorded to the caller;
     *      claim() picks the RSUP receiver. estimatedClaimEpoch() reports the outcome.
     * @return batchId Batch the request was recorded in
     * @return owed RSUP claimable once the batch matures
     */
    function requestWithdraw(uint256 _shares) external nonReentrant returns (uint256 batchId, uint256 owed) {
        if (_shares == 0) revert ZeroAmount();
        // record new yield and convert it into magicStaker stake, so it can be cooled down from the next epoch
        _sync(true);

        uint256 assets = convertToAssets(_shares);
        // withdrawFee of the assets, but never more than feeCap usRSUP worth
        uint256 fee = Math.min(Math.mulDiv(assets, withdrawFee, DENOM, Math.Rounding.Ceil), convertToAssets(feeCap));
        owed = assets - fee;
        if (owed == 0) revert ZeroAmount();
        _burn(msg.sender, _shares);
        backlogOwed += owed;
        feePot += fee;

        bool cooldownNow = canCooldown();
        if (cooldownNow) {
            // clear any eligible backlog first, without keeper reward. Best effort: a failed cooldown leaves it queued.
            _processBacklog(address(0), false);
        }

        if (cooldownNow && owed <= availableToCooldown() && _tryCooldown(owed)) {
            // cooled immediately into its own batch, independent of any backlog that could not be processed
            batchId = nextBatchId++;
            (, uint256 maturity) = magicStaker.accountCooldownData(address(this));
            backlogOwed -= owed;
            feePot -= fee;
            recordedStake -= owed;
            Batch storage cb = batches[batchId];
            cb.owed = uint128(owed);
            cb.fees = uint128(fee);
            _markCooled(batchId, maturity);
            // no keeper involved: the fee stays in the vault
            _addProfit(fee);
        } else {
            if (cooldownNow) {
                // a cooldown-week request that can't be cooled now never joins the pending batch, whose older requests
                // must stay coolable this epoch. It goes to the overflow batch instead. It keeps (or makes) the overflow
                // batch coolable this epoch only if, once magicStaker recovers, it would still fit behind what is cooled
                // first: the pending batch, then the overflow batch's existing requests. Otherwise the overflow batch
                // waits for the next cooldown epoch.
                uint256 epoch = magicStaker.getEpoch();
                bool coolableNow = _fitsBehindQueue(owed, epoch);
                if (overflowBatchId == 0) {
                    overflowBatchId = nextBatchId++;
                    overflowEpoch = coolableNow ? epoch - 1 : epoch;
                } else if (!coolableNow) {
                    overflowEpoch = epoch;
                }
                batchId = overflowBatchId;
            } else {
                // outside a cooldown epoch (or the vault can't cool down this epoch)
                batchId = pendingBatchId;
            }
            Batch storage b = batches[batchId];
            b.owed += uint128(owed);
            b.fees += uint128(fee);
        }

        if (requestOf[msg.sender][batchId] == 0) {
            _activeBatchIds[msg.sender].push(batchId);
            _activeIndex[msg.sender][batchId] = _activeBatchIds[msg.sender].length;
        }
        requestOf[msg.sender][batchId] += owed;
        emit WithdrawRequested(msg.sender, batchId, _shares, owed, fee);
    }

    /**
     * @notice Cool down the queued backlog during a cooldown epoch. Caller receives the usRSUP value of the cooled
     *         batches' fees, up to mevCap usRSUP.
     */
    function processBacklog() external nonReentrant returns (uint256 keeperShares) {
        if (!canCooldown()) revert NotCooldownEpoch();
        _sync(true);
        uint256 amount;
        (amount, keeperShares) = _processBacklog(msg.sender, true);
        if (amount == 0) revert NothingToProcess();
    }

    /**
     * @notice Claim matured withdrawals
     * @dev If magicStaker fails to release the vault's matured cooldown, batches already released can still be claimed,
     *      while batches still held in that cooldown revert, so they can never be paid from other batches' RSUP.
     */
    function claim(uint256[] calldata _batchIds, address _receiver) external nonReentrant returns (uint256 total) {
        if (_receiver == address(0)) revert ZeroAddress();
        _pullMatured();
        uint256 epoch = magicStaker.getEpoch();
        // batches with this maturity are still inside magicStaker, unfunded
        (uint256 heldAmount, uint256 heldMaturity) = magicStaker.accountCooldownData(address(this));
        uint256 unfundedMaturity = heldAmount > 0 ? heldMaturity : 0;
        for (uint256 i = 0; i < _batchIds.length; ++i) {
            uint256 id = _batchIds[i];
            uint256 maturity = batches[id].maturityEpoch;
            uint256 owed = requestOf[msg.sender][id];
            if (owed == 0 || maturity == 0 || maturity > epoch || maturity == unfundedMaturity) {
                revert NotClaimable();
            }
            requestOf[msg.sender][id] = 0;
            _removeActive(msg.sender, id);
            total += owed;
            emit WithdrawClaimed(msg.sender, _receiver, id, owed);
        }
        IERC20(asset()).safeTransfer(_receiver, total);
    }

    /**
     * @notice Harvest magicStaker and record the vault's new yield in one call
     * @dev magicStaker pays its harvest caller fee to this contract, which passes it on to the caller, so calling this
     *      earns the same fee as calling magicStaker.harvest() directly, and leaves no gap before the yield is recorded.
     */
    function harvest() external nonReentrant {
        uint256 length = magicStaker.rewardsLength();
        uint256[] memory before = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            before[i] = IERC20(magicStaker.rewards(i)).balanceOf(address(this));
        }
        magicStaker.harvest();
        for (uint256 i = 0; i < length; ++i) {
            address token = magicStaker.rewards(i);
            // magicStaker never uses RSUP as a reward token; skip it and usRSUP anyway so vault funds can never leave here
            if (token == asset() || token == address(this)) continue;
            // only what this harvest paid the vault, not tokens that reached it any other way
            uint256 amount = IERC20(token).balanceOf(address(this)) - before[i];
            if (amount > 0) {
                IERC20(token).safeTransfer(msg.sender, amount);
                emit HarvestForwarded(msg.sender, token, amount);
            }
        }
        _sync(true);
    }

    /// @notice Record new yield as locked profit, and convert it into magicStaker stake (realized next epoch)
    function sync() external nonReentrant {
        _sync(true);
    }

    // ------------------------------------------------------------------------
    // VOTING
    // ------------------------------------------------------------------------

    /**
     * @notice Mirror the existing yes/no split of magicStaker voters with the vault's weight.
     * @dev Allowed when boostEnabled, once magicStaker voters (excluding the vault) reach `boostQuorumBps` of the
     *      non-vault power, and after both the magicVoter delay and `boostDelay`. Must commit the vote in the same
     *      transaction, so the mirrored split can never go stale. The split matches to within 1 bp (rounding).
     */
    function boostQuorum(uint256 _proposalId) external nonReentrant {
        if (!boostEnabled) revert BoostDisabled();
        IMagicVoter mv = IMagicVoter(magicStaker.magicVoter());
        address rsupVoter = mv.voter();

        (bool canVote, uint32 createdAt, uint256 delay) = mv.canVote(_proposalId);
        require(canVote, "!canVote");
        if (block.timestamp <= createdAt + delay || block.timestamp < createdAt + boostDelay) revert BoostTooEarly();

        (uint256 yes, uint256 no) = mv.voteTotals(rsupVoter, _proposalId);
        uint256 voted = yes + no;
        if (voted == 0) revert QuorumNotMet();

        (uint256 stakerPower, uint256 vaultPower) = _boostPowers(mv, createdAt);
        if (voted * DENOM < stakerPower * boostQuorumBps) revert QuorumNotMet();

        uint256 pctYes = (yes * DENOM) / voted;
        uint256 pctNo = DENOM - pctYes;
        mv.vote(_proposalId, pctYes, pctNo);
        if (!mv.executed(rsupVoter, _proposalId)) revert NotCommitted();
        emit QuorumBoosted(_proposalId, pctYes, pctNo, vaultPower);
    }

    // ------------------------------------------------------------------------
    // INTERNAL
    // ------------------------------------------------------------------------

    /// @dev magicStaker voting power at the proposal's epoch: everyone except the vault, and the vault itself
    function _boostPowers(IMagicVoter _mv, uint32 _createdAt) internal returns (uint256 stakerPower, uint256 vaultPower) {
        uint256 createdEpoch = _mv.timeToEpoch(_createdAt);
        magicStaker.checkpointTotal();
        uint256 totalPower = magicStaker.totalPowerAt(createdEpoch);
        vaultPower = magicStaker.getVotingPowerAt(address(this), createdEpoch);
        require(vaultPower > 0, "!power");
        stakerPower = totalPower > vaultPower ? totalPower - vaultPower : 0;
    }

    /**
     * @dev Record stake growth since last sync as locked profit (or a loss).
     *      Optionally converts un-synced pounder yield into magicStaker stake, so it realizes next epoch.
     */
    function _sync(bool _realize) internal {
        if (_realize && magicStaker.unclaimedMagicTokens(address(this)) > 0) {
            magicStaker.syncAccount();
        }
        uint256 current = currentStake();
        uint256 recorded = recordedStake;
        if (current > recorded) {
            _addProfit(current - recorded);
        } else if (current < recorded) {
            uint256 loss = recorded - current;
            uint256 locked = lockedProfit();
            // keep the unlock end; the remaining locked amount unlocks over the rest of the schedule
            lockedProfitStored = locked > loss ? locked - loss : 0;
            lastProfitUpdate = block.timestamp;
            emit LossRecorded(loss);
        }
        recordedStake = current;
    }

    /**
     * @dev Adds profit to the unlock schedule without restarting it for profit already locked. The new end is the
     *      amount-weighted average of the remaining schedule and a full PROFIT_UNLOCK_PERIOD for the new profit,
     *      so small or frequent profits barely move the end (Yearn v3 style).
     */
    function _addProfit(uint256 _profit) internal {
        if (_profit == 0) return;
        uint256 remaining = lockedProfit();
        uint256 remainingTime = fullUnlockTime > block.timestamp ? fullUnlockTime - block.timestamp : 0;
        uint256 newLocked = remaining + _profit;
        uint256 newDuration = (remaining * remainingTime + _profit * PROFIT_UNLOCK_PERIOD) / newLocked;
        if (newDuration == 0) newDuration = 1;
        lockedProfitStored = newLocked;
        lastProfitUpdate = block.timestamp;
        fullUnlockTime = block.timestamp + newDuration;
        emit ProfitRecorded(_profit, newLocked);
    }

    /**
     * @dev Cool down the pending batch, then the overflow batch if overflowEpoch < the current epoch, each
     *      all-or-nothing against the remaining realized stake. Pays `_keeper` the usRSUP value
     *      of the cooled batches' fees, up to mevCap, if non-zero; remaining fees become locked profit.
     *      With `_strict` false, a magicStaker cooldown revert leaves the backlog untouched and returns (0, 0).
     */
    function _processBacklog(address _keeper, bool _strict) internal returns (uint256 amount, uint256 keeperShares) {
        uint256 epoch = magicStaker.getEpoch();
        uint256 available = availableToCooldown();
        uint256 fees;

        uint256 pid = pendingBatchId;
        uint256 pendingOwed = batches[pid].owed;
        bool doPending = pendingOwed > 0 && pendingOwed <= available;
        if (doPending) {
            available -= pendingOwed;
            amount += pendingOwed;
            fees += batches[pid].fees;
        }

        uint256 oid = overflowBatchId;
        bool doOverflow;
        if (oid != 0 && overflowEpoch < epoch) {
            uint256 overflowOwed = batches[oid].owed;
            doOverflow = overflowOwed <= available;
            if (doOverflow) {
                amount += overflowOwed;
                fees += batches[oid].fees;
            }
        }

        if (amount == 0) return (0, 0);

        // auto-unstakes any matured vault cooldown into this contract. No state has changed yet, so a
        // non-strict failure can simply return.
        if (_strict) {
            magicStaker.cooldown(amount);
        } else if (!_tryCooldown(amount)) {
            return (0, 0);
        }
        (, uint256 maturity) = magicStaker.accountCooldownData(address(this));

        recordedStake -= amount;
        backlogOwed -= amount;

        if (doPending) {
            _markCooled(pid, maturity);
            pendingBatchId = nextBatchId++;
        }
        if (doOverflow) {
            _markCooled(oid, maturity);
            overflowBatchId = 0;
        }

        keeperShares = _settleFees(_keeper, fees);
        emit BacklogProcessed(_keeper, amount, fees, keeperShares);
    }

    /// @dev Settle the fees of cooled batches: the keeper reward is minted at fair value, the rest unlocks to holders
    function _settleFees(address _keeper, uint256 _fees) internal returns (uint256 keeperShares) {
        uint256 rewardAssets;
        if (_keeper != address(0) && _fees > 0) {
            keeperShares = Math.min(mevCap, convertToShares(_fees));
            // round up so minting never lowers the share price for holders. Never exceeds _fees, because
            // keeperShares <= convertToShares(_fees), which rounds down.
            rewardAssets = _convertToAssets(keeperShares, Math.Rounding.Ceil);
        }
        feePot -= _fees;
        if (keeperShares > 0) _mint(_keeper, keeperShares);
        _addProfit(_fees - rewardAssets);
    }

    /// @dev Whether `_owed` more would still be cooled in this epoch's processing order: after the pending batch, and
    ///      together with the overflow batch's existing requests if that batch is already coolable this epoch.
    function _fitsBehindQueue(uint256 _owed, uint256 _epoch) internal view returns (bool) {
        uint256 available = availableToCooldown();
        uint256 pendingOwed = batches[pendingBatchId].owed;
        if (pendingOwed <= available) available -= pendingOwed;
        uint256 ahead;
        if (overflowBatchId != 0 && overflowEpoch < _epoch) ahead = batches[overflowBatchId].owed;
        return ahead + _owed <= available;
    }

    function _markCooled(uint256 _id, uint256 _maturity) internal {
        Batch storage b = batches[_id];
        b.maturityEpoch = uint64(_maturity);
        emit BatchCooled(_id, b.owed, _maturity);
    }

    /// @dev Remove a claimed batch from the account's active set in constant time (swap with last, pop)
    function _removeActive(address _account, uint256 _id) internal {
        uint256[] storage ids = _activeBatchIds[_account];
        uint256 position = _activeIndex[_account][_id];
        uint256 last = ids[ids.length - 1];
        if (last != _id) {
            ids[position - 1] = last;
            _activeIndex[_account][last] = position;
        }
        ids.pop();
        delete _activeIndex[_account][_id];
    }

    function _tryCooldown(uint256 _amount) internal returns (bool) {
        try magicStaker.cooldown(_amount) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Unstake the vault's matured magicStaker cooldown, if any. Failure is tolerated; claim() then refuses
    ///      only the batches still held in magicStaker.
    function _pullMatured() internal {
        (uint256 amount, uint256 maturity) = magicStaker.accountCooldownData(address(this));
        if (amount > 0 && maturity <= magicStaker.getEpoch()) {
            try magicStaker.unstake() {} catch {}
        }
    }

    // ------------------------------------------------------------------------
    // OWNER FUNCTIONS
    // ------------------------------------------------------------------------

    /// @notice Disabled: renouncing would freeze every owner setting forever. Hand over with transferOwnership instead.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /**
     * @notice Seed the vault. Seed shares are sent to a dead address to prevent share inflation attacks.
     */
    function initialize(uint256 _seedAssets) external onlyOwner nonReentrant {
        require(!initialized, "!initialized");
        require(_seedAssets >= 1e18, "!seed");
        initialized = true;
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), _seedAssets);
        _stakeAndMint(msg.sender, DEAD, _seedAssets, previewDeposit(_seedAssets));
        emit Initialized(_seedAssets);
    }

    /**
     * @notice Set, replace, or remove (address(0)) the usRSUP/RSUP Curve pool.
     * @dev The vault never gives the pool an allowance, so replacing it leaves nothing behind.
     */
    function setCurvePool(address _pool) external onlyOwner {
        if (_pool == address(0)) {
            // switches Curve routing off: depositWithRoute mints everything, withdrawViaCurve reverts NoPool
            curvePool = ICurvePool(address(0));
            emit CurvePoolSet(address(0));
            return;
        }
        address c0 = ICurvePool(_pool).coins(0);
        address c1 = ICurvePool(_pool).coins(1);
        if (c0 == asset() && c1 == address(this)) {
            poolRsupIndex = 0;
            poolTokenIndex = 1;
        } else if (c0 == address(this) && c1 == asset()) {
            poolRsupIndex = 1;
            poolTokenIndex = 0;
        } else {
            revert InvalidParam();
        }
        curvePool = ICurvePool(_pool);
        emit CurvePoolSet(_pool);
    }

    /// @notice Pause deposits. Withdrawal requests, processing and claims are never paused.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    // ------------------------------------------------------------------------
    // OWNER PARAMETERS
    // ------------------------------------------------------------------------

    function setWithdrawFee(uint256 _fee) external onlyOwner {
        if (_fee > MAX_WITHDRAW_FEE) revert InvalidParam();
        withdrawFee = _fee;
        emit WithdrawFeeSet(_fee);
    }

    /// @notice Keeper reward cap per processBacklog call, in usRSUP. 0 disables the keeper reward.
    function setMevCap(uint256 _cap) external onlyOwner {
        if (_cap > MAX_MEV_CAP) revert InvalidParam();
        mevCap = _cap;
        emit MevCapSet(_cap);
    }

    /// @notice Withdraw fee cap per request, in usRSUP (the fee is charged as its RSUP value). 0 disables the withdraw fee.
    function setFeeCap(uint256 _cap) external onlyOwner {
        if (_cap > MAX_FEE_CAP) revert InvalidParam();
        feeCap = _cap;
        emit FeeCapSet(_cap);
    }

    function setBoostQuorum(uint256 _quorum) external onlyOwner {
        if (_quorum < MIN_BOOST_QUORUM || _quorum > MAX_BOOST_QUORUM) revert InvalidParam();
        boostQuorumBps = _quorum;
        emit BoostQuorumSet(_quorum);
    }

    /// @notice Switch the quorum boost off, e.g. once usRSUP is the dominant magicStaker account
    function setBoostEnabled(bool _enabled) external onlyOwner {
        boostEnabled = _enabled;
        emit BoostEnabledSet(_enabled);
    }

    function setBoostDelay(uint256 _delay) external onlyOwner {
        if (_delay > MAX_BOOST_DELAY) revert InvalidParam();
        boostDelay = _delay;
        emit BoostDelaySet(_delay);
    }

    // Fallback executable function
    function execute(
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external onlyOwner returns (bool, bytes memory) {
        (bool success, bytes memory result) = _to.call{value: _value}(_data);
        require(success, "execute failed");
        emit Executed(_to, _value, _data, success);
        return (success, result);
    }
}
