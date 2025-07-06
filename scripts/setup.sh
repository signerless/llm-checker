#!/bin/bash

# LLM Checker Setup Script
# This script sets up the development environment and installs dependencies

set -e  # Exit on any error

echo "🚀 Setting up LLM Checker development environment..."
echo "======================================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Node.js is installed
check_nodejs() {
    print_status "Checking Node.js installation..."

    if command -v node >/dev/null 2>&1; then
        NODE_VERSION=$(node --version)
        print_success "Node.js found: $NODE_VERSION"

        # Check if version is >= 16
        MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
        if [ "$MAJOR_VERSION" -ge 16 ]; then
            print_success "Node.js version is compatible"
        else
            print_error "Node.js version must be >= 16.0.0"
            print_status "Please update Node.js: https://nodejs.org/"
            exit 1
        fi
    else
        print_error "Node.js not found"
        print_status "Please install Node.js: https://nodejs.org/"
        exit 1
    fi
}

# Check if npm is installed
check_npm() {
    print_status "Checking npm installation..."

    if command -v npm >/dev/null 2>&1; then
        NPM_VERSION=$(npm --version)
        print_success "npm found: v$NPM_VERSION"
    else
        print_error "npm not found"
        print_status "npm should be installed with Node.js"
        exit 1
    fi
}

# Install dependencies
install_dependencies() {
    print_status "Installing npm dependencies..."

    if [ -f "package.json" ]; then
        npm install
        print_success "Dependencies installed successfully"
    else
        print_error "package.json not found"
        print_status "Are you running this script from the project root?"
        exit 1
    fi
}

# Install system dependencies based on OS
install_system_deps() {
    print_status "Installing system dependencies..."

    # Detect OS
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        print_status "Detected Linux system"

        if command -v apt-get >/dev/null 2>&1; then
            # Debian/Ubuntu
            print_status "Installing dependencies for Debian/Ubuntu..."
            sudo apt-get update
            sudo apt-get install -y dmidecode lm-sensors
        elif command -v yum >/dev/null 2>&1; then
            # RedHat/CentOS
            print_status "Installing dependencies for RedHat/CentOS..."
            sudo yum install -y dmidecode lm_sensors
        elif command -v pacman >/dev/null 2>&1; then
            # Arch Linux
            print_status "Installing dependencies for Arch Linux..."
            sudo pacman -S --noconfirm dmidecode lm_sensors
        else
            print_warning "Unknown Linux distribution, skipping system dependencies"
        fi

    elif [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        print_status "Detected macOS system"
        print_status "No additional system dependencies needed for macOS"

    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        # Windows
        print_status "Detected Windows system"
        print_status "No additional system dependencies needed for Windows"

    else
        print_warning "Unknown operating system: $OSTYPE"
        print_warning "Some hardware detection features may not work properly"
    fi
}

# Setup development directories
setup_directories() {
    print_status "Setting up development directories..."

    # Create directories if they don't exist
    mkdir -p ~/.llm-checker/logs
    mkdir -p ~/.llm-checker/reports
    mkdir -p ~/.llm-checker/cache

    print_success "Development directories created"
}

# Setup git hooks (if in git repo)
setup_git_hooks() {
    if [ -d ".git" ]; then
        print_status "Setting up git hooks..."

        # Pre-commit hook
        cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
# Run tests before commit
npm test
EOF

        chmod +x .git/hooks/pre-commit
        print_success "Git hooks configured"
    else
        print_status "Not a git repository, skipping git hooks setup"
    fi
}

# Test installation
test_installation() {
    print_status "Testing installation..."

    # Test if the CLI can be executed
    if node bin/enhanced_cli.js --version >/dev/null 2>&1; then
        print_success "CLI test passed"
    else
        print_error "CLI test failed"
        exit 1
    fi

    # Test basic functionality
    if npm test >/dev/null 2>&1; then
        print_success "Unit tests passed"
    else
        print_warning "Some tests failed, but installation is functional"
    fi
}

# Install Ollama (optional)
install_ollama() {
    print_status "Would you like to install Ollama? (y/N)"
    read -r response

    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        print_status "Installing Ollama..."

        if [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "darwin"* ]]; then
            curl -fsSL https://ollama.ai/install.sh | sh
            print_success "Ollama installed successfully"
            print_status "You can now use: ollama pull llama3.2:3b"
        else
            print_status "Please visit https://ollama.ai to install Ollama on Windows"
        fi
    else
        print_status "Skipping Ollama installation"
        print_status "You can install it later from: https://ollama.ai"
    fi
}

# Main setup function
main() {
    echo ""
    print_status "Starting setup process..."

    # Check prerequisites
    check_nodejs
    check_npm

    # Install dependencies
    install_dependencies
    install_system_deps

    # Setup environment
    setup_directories
    setup_git_hooks

    # Test installation
    test_installation

    # Optional: Install Ollama
    install_ollama

    echo ""
    print_success "Setup completed successfully! 🎉"
    echo ""
    print_status "Next steps:"
    echo "  1. Run: npm link                    # Install globally"
    echo "  2. Run: llm-checker check           # Test the tool"
    echo "  3. Run: llm-checker --help          # See all options"
    echo ""
    print_status "For development:"
    echo "  - Run tests: npm test"
    echo "  - Run benchmarks: node scripts/benchmark.js"
    echo "  - View logs: tail -f ~/.llm-checker/logs/llm-checker.log"
    echo ""
    print_status "Documentation: https://github.com/Pavelevich/llm-checker"
}

# Run main function
main "$@"