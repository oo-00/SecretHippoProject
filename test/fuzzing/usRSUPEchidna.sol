// SPDX-License-Identifier: Open Source
pragma solidity ^0.8.30;

/*
    Echidna invariant harness for usRSUP.

    Runs usRSUP against MockMagicStaker (contracts/test) with a mock RSUP token deployed at the real RSUP
    address (echidna.usRSUP.yaml: deployContracts). Echidna calls the public actions below in random
    sequences. Every action that changes state ends with _checkInvariants() (setRevertCooldown / setRevertUnstake
    don't, and actions that find nothing to do return early), which asserts:

      1. The share price (convertToAssets(1e18)) never decreases. (The harness never calls the mock's slash(),
         so the loss path in _sync is not exercised here; it is covered by usRSUP.failures.test.js.)
      2. recordedStake covers queued withdrawals, queued fees and locked profit (totalAssets never saturates).
      3. recordedStake never exceeds the stake the vault actually holds in magicStaker.
      4. backlogOwed / feePot equal the owed / fees of the pending and overflow batches.
      5. The vault's current cooldown in magicStaker equals what the cooled batches with that cooldown's maturity
         still owe.
      6. Each actor's active batch set is exactly its batches with an unclaimed request (no duplicates).
      7. totalSupply equals the sum of all holders' balances.
      8. No RSUP is stranded: the vault holds exactly what released batches still owe.

    Checked only inside specific actions:
      - deposit / mint / requestWithdraw: never revert, except ZeroAmount when the amount rounds to 0.
      - processBacklog: never reverts while magicStaker accepts cooldowns and a queued batch is estimated as
        claimable from this cycle, and cools that batch.
      - addYield: new yield doesn't move the share price.
      - claimAll: a matured withdrawal can always be claimed while magicStaker releases cooldowns (liveness),
        and pays exactly claimable().
      - processBacklog / requestWithdraw: a queued batch that gets cooled matures exactly at the epoch
        estimatedClaimEpoch() reported just before (while magicStaker accepts cooldowns).
      - processBacklog: a batch it leaves queued is not estimated as claimable from the current cycle.

    Not reachable by this harness (covered by the Hardhat tests instead): stake losses, owner parameter changes,
    pausing, a changed cooldown schedule or pendingCooldownEpoch, depositWithRoute / withdrawViaCurve,
    boostQuorum, harvest() reward forwarding (the mock's reward list is empty here), and RSUP or usRSUP sent
    directly to the vault (invariant 8 relies on that).

    Run: SOLC_VERSION=0.8.30 echidna test/fuzzing/usRSUPEchidna.sol --contract usRSUPEchidna --config echidna.usRSUP.yaml
         (solc 0.8.30 installed via `solc-select install 0.8.30`)
*/

import { usRSUP } from "../../contracts/usRSUP.sol";
import { MockMagicStaker } from "../../contracts/test/MockMagicStaker.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface Hevm {
    function warp(uint256) external;
}

/// @dev Deployed by Echidna at the RSUP address (see echidna.usRSUP.yaml deployContracts)
contract MockRSUP is ERC20 {
    constructor() ERC20("Resupply", "RSUP") {}

    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }
}

contract Actor {
    usRSUP internal immutable vault;

    constructor(usRSUP _vault, MockRSUP _rsup) {
        vault = _vault;
        _rsup.approve(address(_vault), type(uint256).max);
    }

    function deposit(uint256 _assets) external returns (uint256) {
        return vault.deposit(_assets, address(this));
    }

    function mint(uint256 _shares) external returns (uint256) {
        return vault.mint(_shares, address(this));
    }

    function requestWithdraw(uint256 _shares) external returns (uint256, uint256) {
        return vault.requestWithdraw(_shares);
    }

    function claim(uint256[] calldata _ids) external returns (uint256) {
        return vault.claim(_ids, address(this));
    }

    function transfer(address _to, uint256 _shares) external {
        vault.transfer(_to, _shares);
    }
}

contract usRSUPEchidna {
    Hevm internal constant hevm = Hevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    MockRSUP internal constant rsup = MockRSUP(0x419905009e4656fdC02418C7Df35B1E61Ed5F726);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant N_ACTORS = 3;

    MockMagicStaker internal ms;
    usRSUP internal vault;
    Actor[N_ACTORS] internal actors;

    uint256 internal time;
    uint256 internal lastPps;
    bool internal ready;

    constructor() {
        time = 1760000000;
        hevm.warp(time);
    }

    /// @dev Echidna deploys the mock RSUP (deployContracts) after this harness's constructor,
    ///      so the system is set up lazily on the first action.
    function _setUp() internal {
        if (ready) return;
        ready = true;
        ms = new MockMagicStaker();
        vault = new usRSUP(address(ms)); // this harness is the owner
        rsup.mint(address(this), 1e30);
        rsup.approve(address(vault), type(uint256).max);
        rsup.approve(address(ms), type(uint256).max);
        vault.initialize(10e18);
        for (uint256 i = 0; i < N_ACTORS; ++i) {
            actors[i] = new Actor(vault, rsup);
        }
        lastPps = vault.convertToAssets(1e18);
    }

    // ------------------------------------------------------------------------
    // ACTIONS
    // ------------------------------------------------------------------------

    function deposit(uint8 _actor, uint256 _assets) public {
        _setUp();
        Actor a = actors[_actor % N_ACTORS];
        _assets = _bound(_assets, 1, 1e24);
        rsup.mint(address(a), _assets);
        try a.deposit(_assets) {} catch (bytes memory err) {
            assert(_selector(err) == usRSUP.ZeroAmount.selector);
        }
        _checkInvariants();
    }

    function mint(uint8 _actor, uint256 _shares) public {
        _setUp();
        Actor a = actors[_actor % N_ACTORS];
        _shares = _bound(_shares, 1, 1e24);
        rsup.mint(address(a), vault.previewMint(_shares));
        try a.mint(_shares) {} catch (bytes memory err) {
            assert(_selector(err) == usRSUP.ZeroAmount.selector);
        }
        _checkInvariants();
    }

    function transfer(uint8 _from, uint8 _to, uint256 _shares) public {
        _setUp();
        Actor a = actors[_from % N_ACTORS];
        uint256 bal = vault.balanceOf(address(a));
        if (bal == 0) return;
        a.transfer(address(actors[_to % N_ACTORS]), _bound(_shares, 1, bal));
        _checkInvariants();
    }

    function requestWithdraw(uint8 _actor, uint256 _shares) public {
        _setUp();
        Actor a = actors[_actor % N_ACTORS];
        uint256 bal = vault.balanceOf(address(a));
        if (bal == 0) return;
        (uint256[2] memory ids, uint256[2] memory estimates) = _queuedEstimates();
        try a.requestWithdraw(_bound(_shares, 1, bal)) {} catch (bytes memory err) {
            // only a request whose owed rounds to 0 may fail
            assert(_selector(err) == usRSUP.ZeroAmount.selector);
        }
        _checkEstimatesKept(ids, estimates);
        _checkInvariants();
    }

    /// @dev Claims every matured batch of an actor; also asserts liveness of claims
    function claimAll(uint8 _actor) public {
        _setUp();
        Actor a = actors[_actor % N_ACTORS];
        uint256[] memory ids = vault.accountActiveBatchIds(address(a));
        uint256 epoch = ms.getEpoch();
        for (uint256 i = 0; i < ids.length; ++i) {
            if (vault.requestOf(address(a), ids[i]) == 0) continue;
            (, , uint64 maturity) = vault.batches(ids[i]);
            if (maturity == 0 || maturity > epoch) continue;
            uint256[] memory one = new uint256[](1);
            one[0] = ids[i];
            uint256 expected = vault.claimable(address(a), ids[i]);
            uint256 before = rsup.balanceOf(address(a));
            try a.claim(one) {
                assert(rsup.balanceOf(address(a)) - before == expected);
            } catch {
                // only allowed to fail while magicStaker refuses to release the matured cooldown
                assert(ms.revertUnstake());
            }
        }
        _checkInvariants();
    }

    function processBacklog() public {
        _setUp();
        (uint256[2] memory ids, uint256[2] memory estimates) = _queuedEstimates();
        uint256 dueNow = ms.getEpoch() + ms.cooldownEpochs() + 1;
        bool ok;
        try vault.processBacklog() { ok = true; } catch {}
        _checkEstimatesKept(ids, estimates);
        if (!ms.revertCooldown()) {
            // liveness: a batch estimated as claimable from this cycle is processable now
            for (uint256 i = 0; i < 2; ++i) {
                if (ids[i] == 0 || estimates[i] != dueNow) continue;
                assert(ok);
                (, , uint64 m) = vault.batches(ids[i]);
                assert(m != 0);
            }
            // a batch processBacklog just left queued must not be estimated as claimable from this cycle
            uint256[2] memory left = [vault.pendingBatchId(), vault.overflowBatchId()];
            for (uint256 i = 0; i < 2; ++i) {
                if (left[i] == 0) continue;
                (uint128 owed, , uint64 m) = vault.batches(left[i]);
                if (owed > 0 && m == 0) assert(vault.estimatedClaimEpoch(left[i]) > dueNow);
            }
        }
        _checkInvariants();
    }

    function harvest() public {
        _setUp();
        vault.harvest();
        _checkInvariants();
    }

    function sync() public {
        _setUp();
        vault.sync();
        _checkInvariants();
    }

    function addYield(uint256 _amount) public {
        _setUp();
        _amount = _bound(_amount, 1, 1e22);
        uint256 ppsBefore = vault.convertToAssets(1e18);
        ms.addYield(address(vault), _amount);
        // yield alone never moves the share price
        assert(vault.convertToAssets(1e18) == ppsBefore);
        _checkInvariants();
    }

    function advanceTime(uint256 _seconds) public {
        _setUp();
        time += _bound(_seconds, 1 hours, 3 weeks);
        hevm.warp(time);
        _checkInvariants();
    }

    function setRevertCooldown(bool _v) public {
        _setUp();
        ms.setRevertCooldown(_v);
    }

    function setRevertUnstake(bool _v) public {
        _setUp();
        ms.setRevertUnstake(_v);
    }

    /// @dev Make part of the vault's stake unrealized this epoch (e.g. large deposits in a cooldown week)
    function forcePending(uint256 _amount) public {
        _setUp();
        (uint112 realized, , , ) = ms.accountStakeData(address(vault));
        if (realized == 0) return;
        ms.forcePending(address(vault), _bound(_amount, 0, realized));
        _checkInvariants();
    }

    // ------------------------------------------------------------------------
    // INVARIANTS
    // ------------------------------------------------------------------------

    /// @dev estimatedClaimEpoch of the queued pending and overflow batches, taken before an action
    function _queuedEstimates() internal view returns (uint256[2] memory ids, uint256[2] memory estimates) {
        ids = [vault.pendingBatchId(), vault.overflowBatchId()];
        for (uint256 i = 0; i < 2; ++i) {
            if (ids[i] != 0) estimates[i] = vault.estimatedClaimEpoch(ids[i]);
        }
    }

    /// @dev A queued batch that the action cooled must mature exactly when it was estimated to, beforehand
    ///      (only while magicStaker accepts cooldowns; the mock's revert switch can change the outcome).
    function _checkEstimatesKept(uint256[2] memory _ids, uint256[2] memory _estimates) internal view {
        if (ms.revertCooldown()) return;
        for (uint256 i = 0; i < 2; ++i) {
            if (_ids[i] == 0 || _estimates[i] == 0) continue;
            (, , uint64 m) = vault.batches(_ids[i]);
            if (m != 0) assert(m == _estimates[i]);
        }
    }

    function _checkInvariants() internal {
        // 1. share price never decreases
        uint256 pps = vault.convertToAssets(1e18);
        assert(pps >= lastPps);
        lastPps = pps;

        // 2. recorded stake covers everything excluded from totalAssets
        uint256 recorded = vault.recordedStake();
        assert(recorded >= vault.backlogOwed() + vault.feePot() + vault.lockedProfit());

        // 3. recorded stake never exceeds what the vault actually holds in magicStaker
        assert(recorded <= ms.balanceOf(address(vault)) + ms.unclaimedMagicTokens(address(vault)));

        // 4. backlog totals match the queued batches
        (uint128 pOwed, uint128 pFees, uint64 pMaturity) = vault.batches(vault.pendingBatchId());
        assert(pMaturity == 0);
        uint256 owedQueued = pOwed;
        uint256 feesQueued = pFees;
        uint256 oid = vault.overflowBatchId();
        if (oid != 0) {
            (uint128 oOwed, uint128 oFees, uint64 oMaturity) = vault.batches(oid);
            assert(oMaturity == 0);
            owedQueued += oOwed;
            feesQueued += oFees;
        }
        assert(vault.backlogOwed() == owedQueued);
        assert(vault.feePot() == feesQueued);

        // 5. RSUP solvency for cooled batches
        (uint256 heldAmount, uint256 heldMaturity) = ms.accountCooldownData(address(vault));
        uint256 releasedOwed;
        uint256 heldOwed;
        for (uint256 i = 0; i < N_ACTORS; ++i) {
            address who = address(actors[i]);
            uint256[] memory ids = vault.accountActiveBatchIds(who);
            for (uint256 j = 0; j < ids.length; ++j) {
                uint256 owed = vault.requestOf(who, ids[j]);
                if (owed == 0) continue;
                (, , uint64 bMaturity) = vault.batches(ids[j]);
                if (bMaturity == 0) continue;
                if (heldAmount > 0 && bMaturity == heldMaturity) heldOwed += owed;
                else releasedOwed += owed;
            }
        }
        // batches are only ever cooled in full, so the cooldown holds exactly what its batches owe
        assert(heldAmount == heldOwed);

        // 6. each actor's active set is exactly its batches with requestOf > 0
        for (uint256 i = 0; i < N_ACTORS; ++i) {
            address who = address(actors[i]);
            uint256[] memory active = vault.accountActiveBatchIds(who);
            // ground truth: every batch id ever created
            uint256 outstanding;
            for (uint256 id = 1; id < vault.nextBatchId(); ++id) {
                if (vault.requestOf(who, id) > 0) outstanding++;
            }
            assert(active.length == outstanding);
            for (uint256 j = 0; j < active.length; ++j) {
                assert(vault.requestOf(who, active[j]) > 0);
                for (uint256 k = j + 1; k < active.length; ++k) assert(active[j] != active[k]);
            }
        }

        // 7. supply accounting
        uint256 sum = vault.balanceOf(DEAD) + vault.balanceOf(address(this));
        for (uint256 i = 0; i < N_ACTORS; ++i) sum += vault.balanceOf(address(actors[i]));
        assert(vault.totalSupply() == sum);

        // 8. no RSUP gets stranded: the vault holds exactly what released batches still owe
        assert(rsup.balanceOf(address(vault)) == releasedOwed);
    }

    function _selector(bytes memory _err) internal pure returns (bytes4 s) {
        if (_err.length >= 4) {
            assembly {
                s := mload(add(_err, 32))
            }
        }
    }

    function _bound(uint256 _x, uint256 _lo, uint256 _hi) internal pure returns (uint256) {
        return _lo + (_x % (_hi - _lo + 1));
    }
}
