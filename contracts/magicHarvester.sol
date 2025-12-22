// SPDX-License-Identifier: Open Source

//  You should personally audit and test this code before using it.

pragma solidity ^0.8.30;

import { IERC20, SafeERC20 } from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import { IERC20Metadata } from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import { OperatorManager } from "./operatorManager.sol";

interface CurvePool {
    function exchange(
        int128 i,
        int128 j,
        uint256 _dx,
        uint256 _min_dy
    ) external payable returns (uint256);
    function price_oracle(uint256 i) external view returns (uint256);
}

interface AltCurvePool {
    function exchange(
        uint256 i,
        uint256 j,
        uint256 _dx,
        uint256 _min_dy
    ) external payable returns (uint256);
    function price_oracle(uint256 i) external view returns (uint256);
    function price_oracle() external view returns (uint256);
}

interface ScrvUSD {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
    function pricePerShare() external view returns (uint256);
}

interface SreUSD {
    function deposit(uint256 _assets, address _receiver) external;
    function redeem(uint256 _shares, address _receiver, address _owner) external;
}

interface Strategy {
    function desiredToken() external view returns (address);
    function notifyReward(uint256 _amount) external;
}

contract magicHarvester is OperatorManager {
    using SafeERC20 for IERC20;

    struct Route {
        address pool;
        address tokenIn;
        address tokenOut;
        uint256 functionType;
        uint256 indexIn;
        uint256 indexOut;
    }

    uint256 maxSlippage = 500; // 5% default max slippage
    ScrvUSD public constant SCRVUSD = ScrvUSD(0x0655977FEb2f289A4aB78af67BAB0d17aAb84367);

    mapping(address => mapping(address => Route[])) public routes; // tokenIn => tokenOut => route[]
    mapping(address => bool) public rewardCaller;

    constructor(address _operator, address _manager) OperatorManager(_operator, _manager) {}

    event Executed(address to, uint256 value, bytes data, bool success);
    event AddRewardCaller(address indexed caller);
    event RemoveRewardCaller(address indexed caller);
    event SetRoute(address indexed tokenIn, address indexed tokenOut, uint256 routeLength);
    event Processed(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event StrategyApproval(address indexed token, address indexed strategy, bool approved);

    function addRewardCaller(address _caller) external onlyManager {
        rewardCaller[_caller] = true;
        emit AddRewardCaller(_caller);
    }
    function removeRewardCaller(address _caller) external onlyManager {
        rewardCaller[_caller] = false;
        emit RemoveRewardCaller(_caller);
    }
    function setMaxSlippage(uint256 _maxSlippage) external onlyOperator {
        require(_maxSlippage <= 2000, "!slippage"); // max 20%
        maxSlippage = _maxSlippage;
    }

    function getRoute(address _tokenIn,  address _tokenOut) external view returns (Route[] memory) {
        return routes[_tokenIn][_tokenOut];
    }

    function approveStrategy(address _strategy, bool _approve) external onlyOperator {
        address strategyToken = Strategy(_strategy).desiredToken();
        IERC20(strategyToken).approve(_strategy, _approve ? type(uint256).max : 0);
        emit StrategyApproval(strategyToken, _strategy, _approve);
    }

    function setRoute(
        address _tokenIn,
        Route[] memory _routes,
        address _tokenOut,
        uint256 _testAmount,
        bool _removeApprovals
    ) external onlyOperator {
        uint256 startTokenOut = IERC20(_tokenOut).balanceOf(address(this));
        // can pass 0 routes to delete existing route, otherwise needs validation and test
        if(_routes.length > 0) {
            require(_routes[0].tokenIn == _tokenIn, "!start");
            require(_routes[_routes.length - 1].tokenOut == _tokenOut, "!end");
            require(_testAmount > 0, "!test");
        }

        if(_removeApprovals) {
            // remove token approvals for each step
            for (uint256 i = 0; i < routes[_tokenIn][_tokenOut].length; ++i) {
                IERC20(routes[_tokenIn][_tokenOut][i].tokenIn).approve(routes[_tokenIn][_tokenOut][i].pool, 0);
            }
        }
        for (uint256 i = 0; i < _routes.length; ++i) {
            if(i > 0) {
                // validate route continuity
                require(_routes[i-1].tokenOut == _routes[i].tokenIn, "!chain");
            }
            // approve token for curve pools
            if(_routes[i].functionType != 1) { // scrvUSD redeem doesn't need approval
                IERC20(_routes[i].tokenIn).approve(_routes[i].pool, type(uint256).max);
            }
        }
        // overwrite routes
        routes[_tokenIn][_tokenOut] = _routes;
        
        if(_routes.length == 0) {
            return;
        }

        // test route
        _process(_tokenIn, _tokenOut, _testAmount);
        uint256 endTokenOut = IERC20(_tokenOut).balanceOf(address(this));
        IERC20(_tokenOut).safeTransfer(msg.sender, endTokenOut - startTokenOut);
    }

    function process(address[10] memory _tokensIn, uint256[10] memory _amountsIn, address _strategy) external returns (uint256 tokenOutBal) {
        require(rewardCaller[msg.sender], "!auth");
        Strategy strategy = Strategy(_strategy);
        address strategyToken = strategy.desiredToken();
        require(strategyToken != address(0), "!tokenOut");
        uint256 startTokenOut = IERC20(strategyToken).balanceOf(address(this));
        for (uint256 i = 0; i < _tokensIn.length; ++i) {
            if(_tokensIn[i] == address(0)) {
                break;
            }
            if(_amountsIn[i] == 0) {
                continue;
            }
            require(routes[_tokensIn[i]][strategyToken].length > 0, "!route");
            _process(_tokensIn[i], strategyToken, _amountsIn[i]);
        }
        // notify strategy of reward
        uint256 endTokenOut = IERC20(strategyToken).balanceOf(address(this));
        tokenOutBal = endTokenOut - startTokenOut;
        if(tokenOutBal > 0) {
            strategy.notifyReward(tokenOutBal);
        }
    }

    function _process(address _tokenIn, address _tokenOut, uint256 _amountIn) internal {
        require(_amountIn > 0, "!amount");
        IERC20(_tokenIn).safeTransferFrom(msg.sender, address(this), _amountIn);
        for (uint256 i = 0; i < routes[_tokenIn][_tokenOut].length; ++i) {
            Route memory route = routes[_tokenIn][_tokenOut][i];
            uint256 bal = IERC20(route.tokenIn).balanceOf(address(this));
            require(bal > 0, "!balance");
            if (route.functionType == 0) {
                // curve exchange
                uint256 oracle = CurvePool(route.pool).price_oracle(0);
                uint256 expectedOut;
                if(route.indexIn == 1) {
                    expectedOut = (bal * (oracle * SCRVUSD.pricePerShare() / (10 ** 18))) / (10 ** 18); // Curve oracle is in 18 decimals
                } else {
                    expectedOut = (bal * (10 ** 18)) / (oracle * SCRVUSD.pricePerShare() / (10 ** 18)); // And scrvUSD pools are denominated in crvUSD underlying
                }
                uint256 minOut = (expectedOut * (10000 - maxSlippage)) / 10000;

                CurvePool(route.pool).exchange{value: 0}(int128(int256(route.indexIn)), int128(int256(route.indexOut)), bal, minOut);
            } else if (route.functionType == 1) {
                // scrvUSD redeem
                SCRVUSD.redeem(bal, address(this), address(this));
            } else if (route.functionType == 2) {
                // alt curve exchange
                uint256 expectedOut;
                if(route.indexIn == 0) {
                    expectedOut = (bal * (10 ** 18)) / AltCurvePool(route.pool).price_oracle(0);
                } else {
                    expectedOut = (bal * AltCurvePool(route.pool).price_oracle(0)) / (10 ** 18);
                }
                uint256 minOut = (expectedOut * (10000 - maxSlippage)) / 10000;
                AltCurvePool(route.pool).exchange{value: 0}(route.indexIn, route.indexOut, bal, minOut);
            } else if (route.functionType == 3) {
                // sreUSD exchange
                SreUSD(route.pool).deposit(bal, address(this));
            } else if (route.functionType == 4) {
                // 2nd alt curve exchange
                uint256 expectedOut;
                if(route.indexIn == 0) {
                    expectedOut = (bal * (10 ** 18)) / AltCurvePool(route.pool).price_oracle();
                } else {
                    expectedOut = (bal * AltCurvePool(route.pool).price_oracle()) / (10 ** 18);
                }
                uint256 minOut = (expectedOut * (10000 - maxSlippage)) / 10000;
                AltCurvePool(route.pool).exchange{value: 0}(route.indexIn, route.indexOut, bal, minOut);
            } else {
                revert("!function");
            }
            require(IERC20(route.tokenIn).balanceOf(address(this)) == 0, "!spent");
        }
    }
    // Fallback executable function
    function execute(
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external onlyOperator returns (bool, bytes memory) {
        require(msg.sender == RESUPPLY_CORE, "!auth");
        (bool success, bytes memory result) = _to.call{value: _value}(_data);
        emit Executed(_to, _value, _data, success);
        return (success, result);
    }
}