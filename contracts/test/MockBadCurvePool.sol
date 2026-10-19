// SPDX-License-Identifier: Open Source

pragma solidity ^0.8.30;

/**
 * @dev Test-only Curve pool that reports generous quotes and swap results but keeps everything sent to it.
 *      Used to check that usRSUP counts what the receiver actually gets. Not for deployment.
 */
contract MockBadCurvePool {
    address public immutable coin0;
    address public immutable coin1;

    constructor(address _coin0, address _coin1) {
        coin0 = _coin0;
        coin1 = _coin1;
    }

    function coins(uint256 i) external view returns (address) {
        return i == 0 ? coin0 : coin1;
    }

    function get_dy(int128, int128, uint256 dx) external pure returns (uint256) {
        return dx * 2;
    }

    function exchange_received(int128, int128, uint256 dx, uint256, address) external pure returns (uint256) {
        return dx * 2; // claims a great swap, sends nothing
    }
}
