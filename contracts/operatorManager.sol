// SPDX-License-Identifier: Open Source

pragma solidity ^0.8.30;

contract OperatorManager {
    address public constant RESUPPLY_CORE = 0xc07e000044F95655c11fda4cD37F70A94d7e0a7d;
    address public operator;
    address public pendingOperator;
    address public manager;

    constructor(address _operator, address _manager) {
        operator = _operator;
        manager = _manager;
    }

    event NewPendingOperator(address _pendingOperator);
    event NewOperator(address _operator);
    event NewManager(address _manager);

    modifier onlyOperator() {
        require(msg.sender == operator || msg.sender == RESUPPLY_CORE, "!auth");
        _;
    }

    modifier onlyManager() {
        require(msg.sender == manager || msg.sender == operator || msg.sender == RESUPPLY_CORE, "!auth" );
        _;
    }

    function changeOperator(address _pendingOperator) external onlyOperator {
        pendingOperator = _pendingOperator;
        emit NewPendingOperator(_pendingOperator);
    }

    function acceptOperator() external {
        require(msg.sender == pendingOperator, "!auth");
        operator = pendingOperator;
        pendingOperator = address(0);
        emit NewOperator(operator);
    }

    function changeManager(address newManager) external onlyOperator {
        // is okay if this is zero address since operator can perform manager duties
        manager = newManager;
        emit NewManager(manager);
    }

}
