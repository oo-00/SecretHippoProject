// SPDX-License-Identifier: Open Source

pragma solidity ^0.8.30;

import { IERC20, SafeERC20 } from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

/**
 * @dev Test-only stand-in for magicStaker, modelling the parts usRSUP depends on
 *      (epochs, pending -> realized stake, one cooldown slot per account, pounder yield, harvest caller fees),
 *      with test controls: revert switches for cooldown/unstake, pause, addYield, forcePending, slash (stake loss),
 *      cooldown schedule and pendingCooldownEpoch setters, voting power and magicVoter setters, and a reward-token
 *      list with per-token harvest fees. Not for deployment.
 *      Fidelity note: cooldown() always sets maturity to epoch + cooldownEpochs + 1 and never reverts with
 *      CooldownsPending; setPendingCooldownEpoch only drives usRSUP's canCooldown() view. Schedule-change tests
 *      therefore check usRSUP's own guard, not the real magicStaker's interaction.
 */
contract MockMagicStaker {
    using SafeERC20 for IERC20;

    IERC20 public constant RSUP = IERC20(0x419905009e4656fdC02418C7Df35B1E61Ed5F726);

    struct Account {
        uint112 realized;
        uint112 pending;
        uint16 lastUpdateEpoch;
        uint256 unclaimed;
        uint256 cooldownAmount;
        uint256 cooldownMaturity;
    }

    uint256 public cooldownEpochs = 2;
    uint256 public pendingCooldownEpoch = type(uint256).max;
    bool public paused;
    bool public revertCooldown;
    bool public revertUnstake;
    mapping(address => Account) public accounts;
    address public magicVoter;
    address[] public rewardList;
    mapping(address => uint256) public harvestFee;
    uint256 public totalPower;
    uint256 public accountPower;

    // ---- test controls ----
    function setRevertCooldown(bool _v) external { revertCooldown = _v; }
    function setRevertUnstake(bool _v) external { revertUnstake = _v; }
    function setCooldownEpochs(uint256 _v) external { cooldownEpochs = _v; }
    function setPendingCooldownEpoch(uint256 _v) external { pendingCooldownEpoch = _v; }
    function setMagicVoter(address _v) external { magicVoter = _v; }
    function setPaused(bool _v) external { paused = _v; }
    function setRewards(address[] calldata _tokens) external { rewardList = _tokens; }
    function setHarvestFee(address _token, uint256 _fee) external { harvestFee[_token] = _fee; }
    function setPowers(uint256 _total, uint256 _account) external { totalPower = _total; accountPower = _account; }

    /// @dev Simulate a loss of `_account`'s stake (the real magicStaker can't produce one; tests the loss path)
    function slash(address _account, uint256 _amount) external {
        _checkpoint(_account);
        accounts[_account].realized -= uint112(_amount);
    }

    /// @dev Simulate a pounder harvest for `_account`
    function addYield(address _account, uint256 _amount) external {
        RSUP.safeTransferFrom(msg.sender, address(this), _amount);
        accounts[_account].unclaimed += _amount;
    }

    /// @dev Move realized stake back to pending for this epoch (stake that cannot be cooled until next epoch)
    function forcePending(address _account, uint256 _amount) external {
        _checkpoint(_account);
        Account storage a = accounts[_account];
        a.realized -= uint112(_amount);
        a.pending += uint112(_amount);
    }

    // ---- magicStaker surface used by usRSUP ----
    function getEpoch() public view returns (uint256) {
        return (block.timestamp - 1741824000) / 604800;
    }

    function isCooldownEpoch() public view returns (bool) {
        return getEpoch() % (cooldownEpochs + 1) == 0;
    }

    function staker() external view returns (address) { return address(this); }
    function strategies(uint256) external pure returns (address) { return address(1); }
    function strategiesLength() external pure returns (uint256) { return 1; }
    function setWeights(uint112[] memory) external {}
    function checkpointTotal() external pure returns (uint256) { return 0; }
    /// @dev Pays each listed reward token's configured caller fee (from this contract's balance) to the caller
    function harvest() external {
        for (uint256 i = 0; i < rewardList.length; ++i) {
            uint256 fee = harvestFee[rewardList[i]];
            if (fee > 0) IERC20(rewardList[i]).safeTransfer(msg.sender, fee);
        }
    }
    function rewardsLength() external view returns (uint256) { return rewardList.length; }
    function rewards(uint256 _index) external view returns (address) { return rewardList[_index]; }
    function totalPowerAt(uint256) external view returns (uint256) { return totalPower; }
    function getVotingPowerAt(address, uint256) external view returns (uint256) { return accountPower; }

    function balanceOf(address _account) public view returns (uint256) {
        return uint256(accounts[_account].realized) + accounts[_account].pending;
    }

    function unclaimedMagicTokens(address _account) external view returns (uint256) {
        return accounts[_account].unclaimed;
    }

    function accountStakeData(address _account) external view returns (uint112, uint112, uint112, uint16) {
        Account memory a = accounts[_account];
        return (a.realized, a.pending, 0, a.lastUpdateEpoch);
    }

    function accountCooldownData(address _account) external view returns (uint256, uint256) {
        return (accounts[_account].cooldownAmount, accounts[_account].cooldownMaturity);
    }

    function stake(uint256 _amount) external {
        require(!paused, "paused");
        RSUP.safeTransferFrom(msg.sender, address(this), _amount);
        _checkpoint(msg.sender);
        _syncMagic(msg.sender);
        accounts[msg.sender].pending += uint112(_amount);
    }

    function syncAccount() external {
        require(accounts[msg.sender].unclaimed > 0, "0");
        _checkpoint(msg.sender);
        _syncMagic(msg.sender);
    }

    function cooldown(uint256 _amount) external {
        require(!revertCooldown, "mock: cooldown");
        uint256 epoch = getEpoch();
        require(epoch % (cooldownEpochs + 1) == 0, "!epoch");
        _checkpoint(msg.sender);
        Account storage a = accounts[msg.sender];
        if (a.cooldownAmount > 0 && a.cooldownMaturity <= epoch) _unstake(msg.sender);
        require(a.realized >= _amount, "InsufficientRealizedStake");
        a.realized -= uint112(_amount);
        _syncMagic(msg.sender);
        a.cooldownAmount += _amount;
        a.cooldownMaturity = epoch + cooldownEpochs + 1;
    }

    function unstake() external {
        require(!revertUnstake, "mock: unstake");
        Account storage a = accounts[msg.sender];
        require(a.cooldownAmount > 0, "0");
        require(a.cooldownMaturity <= getEpoch(), "!epoch");
        _unstake(msg.sender);
    }

    function _unstake(address _account) internal {
        uint256 amount = accounts[_account].cooldownAmount;
        accounts[_account].cooldownAmount = 0;
        RSUP.safeTransfer(_account, amount);
    }

    function _checkpoint(address _account) internal {
        Account storage a = accounts[_account];
        uint256 epoch = getEpoch();
        if (a.lastUpdateEpoch < epoch) {
            a.realized += a.pending;
            a.pending = 0;
            a.lastUpdateEpoch = uint16(epoch);
        }
    }

    function _syncMagic(address _account) internal {
        Account storage a = accounts[_account];
        if (a.unclaimed > 0) {
            a.pending += uint112(a.unclaimed);
            a.unclaimed = 0;
        }
    }
}
