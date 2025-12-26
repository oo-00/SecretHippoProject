#!/bin/bash
# Fuzzing Test Runner Script
# This script runs Echidna fuzzing tests with different configurations

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"

echo "=========================================="
echo "Echidna Fuzzing Test Suite"
echo "=========================================="
echo ""

# Check if echidna is installed
if ! command -v echidna &> /dev/null; then
    echo "❌ Echidna is not installed!"
    echo ""
    echo "Please install Echidna:"
    echo "  - Via Nix: nix-env -i -f https://github.com/crytic/echidna/tarball/master"
    echo "  - Or download from: https://github.com/crytic/echidna/releases"
    echo ""
    exit 1
fi

echo "✅ Echidna found: $(echidna --version)"
echo ""

# Run mode selection
MODE="${1:-basic}"

case "$MODE" in
    basic)
        echo "Running BASIC fuzzing test (quick validation)..."
        echo "Test limit: 1000 sequences"
        echo ""
        echo "Testing: ComprehensiveFuzzTest..."
        echidna test/fuzzing/ComprehensiveFuzzTest.sol \
            --contract ComprehensiveFuzzTest \
            --config echidna.yaml \
            --test-limit 1000
        echo ""
        echo "Testing: MagicStakerFuzzTest..."
        echidna test/fuzzing/MagicStakerFuzzTest.sol \
            --contract MagicStakerFuzzTest \
            --config echidna.yaml \
            --test-limit 1000
        ;;
    
    standard)
        echo "Running STANDARD fuzzing test (1 hour)..."
        echo "Test limit: 50000 sequences (default)"
        echo ""
        echo "Testing: ComprehensiveFuzzTest..."
        echidna test/fuzzing/ComprehensiveFuzzTest.sol \
            --contract ComprehensiveFuzzTest \
            --config echidna.yaml
        echo ""
        echo "Testing: MagicStakerFuzzTest..."
        echidna test/fuzzing/MagicStakerFuzzTest.sol \
            --contract MagicStakerFuzzTest \
            --config echidna.yaml
        ;;
    
    extended)
        echo "Running EXTENDED fuzzing test (24+ hours)..."
        echo "Test limit: 10,000,000 sequences"
        echo ""
        echo "Testing: ComprehensiveFuzzTest..."
        echidna test/fuzzing/ComprehensiveFuzzTest.sol \
            --contract ComprehensiveFuzzTest \
            --config echidna.yaml \
            --test-limit 10000000
        echo ""
        echo "Testing: MagicStakerFuzzTest..."
        echidna test/fuzzing/MagicStakerFuzzTest.sol \
            --contract MagicStakerFuzzTest \
            --config echidna.yaml \
            --test-limit 10000000
        ;;
    
    coverage)
        echo "Running with COVERAGE analysis..."
        echo ""
        echo "Testing: ComprehensiveFuzzTest..."
        echidna test/fuzzing/ComprehensiveFuzzTest.sol \
            --contract ComprehensiveFuzzTest \
            --config echidna.yaml \
            --test-limit 10000
        echo ""
        echo "Testing: MagicStakerFuzzTest..."
        echidna test/fuzzing/MagicStakerFuzzTest.sol \
            --contract MagicStakerFuzzTest \
            --config echidna.yaml \
            --test-limit 10000
        echo ""
        echo "Coverage report saved to: echidna-corpus/coverage.txt"
        if [ -f "echidna-corpus/coverage.txt" ]; then
            echo ""
            echo "Coverage Summary:"
            cat echidna-corpus/coverage.txt
        fi
        ;;
    
    legacy)
        echo "Running LEGACY basic test (EchidnaTest.sol)..."
        echo ""
        echidna test/fuzzing/EchidnaTest.sol \
            --contract EchidnaTest \
            --config echidna.yaml
        ;;
    
    protocol)
        echo "Running PROTOCOL-SPECIFIC tests only (MagicStakerFuzzTest)..."
        echo ""
        echidna test/fuzzing/MagicStakerFuzzTest.sol \
            --contract MagicStakerFuzzTest \
            --config echidna.yaml
        ;;
    
    *)
        echo "❌ Unknown mode: $MODE"
        echo ""
        echo "Usage: $0 [mode]"
        echo ""
        echo "Modes:"
        echo "  basic     - Quick validation (1000 sequences, ~1 minute)"
        echo "  standard  - Standard run (50k sequences, ~1 hour)"
        echo "  extended  - Extended campaign (10M sequences, 24+ hours)"
        echo "  coverage  - Quick run with coverage analysis"
        echo "  protocol  - Run MagicStakerFuzzTest only"
        echo "  legacy    - Run legacy EchidnaTest.sol"
        echo ""
        echo "Examples:"
        echo "  $0 basic      # Quick test (both test suites)"
        echo "  $0 standard   # 1 hour campaign (both)"
        echo "  $0 extended   # 24+ hour deep test (both)"
        echo "  $0 coverage   # Coverage analysis (both)"
        echo "  $0 protocol   # Protocol-specific only"
        exit 1
        ;;
esac

echo ""
echo "=========================================="
echo "Fuzzing test complete!"
echo "=========================================="
