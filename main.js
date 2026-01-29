/**
 * GitHub Action for executing Helm commands in a Docker environment
 * @module helm-action
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const tmp = require('tmp');
const { waitFile } = require('wait-file');

// Constants
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const S3_BUCKET = 'doazgpt-public';
const S3_BASE_URL = `https://${S3_BUCKET}.s3.amazonaws.com`;
// Fallback URLs (used if S3 download fails)
const KUBECTL_DOWNLOAD_URL_FALLBACK = 'https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl';
const HELM_INSTALLER_URL = 'https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3';
const ANSI_COLORS = {
    CYAN: '\x1b[36m',
    RESET: '\x1b[0m',
    GREEN: '\x1b[32m',
    RED: '\x1b[31m',
    YELLOW: '\x1b[33m'
};

// Promisified functions
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const appendFile = promisify(fs.appendFile);
const unlink = promisify(fs.unlink);
const rename = promisify(fs.rename);

/**
 * Logs a message with optional color formatting
 * @param {string} message - The message to log
 * @param {string} color - ANSI color code (optional)
 */
function log(message, color = ANSI_COLORS.CYAN) {
    console.log(`${color}${message}${ANSI_COLORS.RESET}`);
}

/**
 * Logs an error message
 * @param {string} message - The error message to log
 */
function logError(message) {
    log(`❌ Error: ${message}`, ANSI_COLORS.RED);
}

/**
 * Logs a success message
 * @param {string} message - The success message to log
 */
function logSuccess(message) {
    log(`✅ ${message}`, ANSI_COLORS.GREEN);
}

/**
 * Logs an info message
 * @param {string} message - The info message to log
 */
function logInfo(message) {
    log(`ℹ️  ${message}`, ANSI_COLORS.CYAN);
}

/**
 * Generates a random string for temporary file/directory names
 * @param {number} length - Length of the random string
 * @returns {string} Random alphanumeric string
 */
function generateRandomString(length = 13) {
    return Math.random().toString(36).replace(/[^a-z0-9]+/g, '').substring(0, length);
}

/**
 * Validates required environment variables
 * @throws {Error} If required inputs are missing
 */
function validateInputs() {
    if (!process.env.INPUT_EXEC) {
        throw new Error('Required input "exec" is missing');
    }
}

/**
 * Sets up kubeconfig file
 * @param {string} kubeConfigPath - Path to kubeconfig file
 * @param {string} backupPath - Path to backup existing kubeconfig
 * @returns {Promise<{exists: boolean, wasBackedUp: boolean}>}
 */
async function setupKubeConfig(kubeConfigPath, backupPath) {
    const kubeConfigExists = fs.existsSync(kubeConfigPath);
    const shouldOverride = process.env.INPUT_OVERRULE_EXISTING_KUBECONFIG === 'true';
    const kubeConfigInput = process.env.INPUT_KUBECONFIG || '';

    if (kubeConfigExists && shouldOverride) {
        logInfo('Existing kubeconfig found, but provided kubeconfig will override it');
        logInfo('Backing up existing kubeconfig for restoration after execution');
        await rename(kubeConfigPath, backupPath);
        await appendFile(kubeConfigPath, `\n\n${kubeConfigInput}\n\n`, { mode: 0o644 });
        return { exists: true, wasBackedUp: true };
    } else if (kubeConfigExists) {
        logInfo('Existing kubeconfig found, using that and ignoring input');
        return { exists: true, wasBackedUp: false };
    } else {
        logInfo('Using kubeconfig from input');
        const kubeDir = path.dirname(kubeConfigPath);
        await mkdir(kubeDir, { recursive: true });
        await appendFile(kubeConfigPath, `\n\n${kubeConfigInput}\n\n`, { mode: 0o644 });
        return { exists: false, wasBackedUp: false };
    }
}

/**
 * Creates the execution script for helm commands
 * @param {string} scriptPath - Path to the script file
 * @param {string} toolsDir - Directory for kubectl and helm binaries
 * @param {string} helmCommand - The helm command to execute
 * @returns {Promise<void>}
 */
async function createExecutionScript(scriptPath, toolsDir, helmCommand) {
    const kubectlPath = path.join(toolsDir, 'kubectl');
    const helmPath = path.join(toolsDir, 'helm');
    
    const scriptContent = `#!/bin/bash
set -e
set -o pipefail

# Function wrappers for kubectl and helm
kubectl() {
    "${kubectlPath}" "$@"
}

helm() {
    "${helmPath}" "$@"
}

# Download and install kubectl from S3 (with fallback)
echo "📥 Downloading kubectl from S3..."
ARCH=$(dpkg --print-architecture || uname -m)
KUBECTL_S3_URL="${S3_BASE_URL}/tools/kubectl/\${ARCH}/kubectl-latest"

if curl -f -s -L -o "${kubectlPath}" "\${KUBECTL_S3_URL}"; then
    chmod +x "${kubectlPath}"
    echo "✅ kubectl downloaded from S3"
else
    echo "⚠️  S3 download failed, trying fallback..."
    KUBECTL_FALLBACK_URL="${KUBECTL_DOWNLOAD_URL_FALLBACK}"
    if ! curl -f -s -L -o "${kubectlPath}" "\${KUBECTL_FALLBACK_URL}"; then
        echo "❌ Failed to download kubectl from both S3 and fallback"
        exit 1
    fi
    chmod +x "${kubectlPath}"
    echo "✅ kubectl downloaded from fallback source"
fi

# Download and install helm from S3 (with fallback)
echo "📥 Downloading Helm from S3..."
# Map architecture names
case "\${ARCH}" in
    amd64|x86_64) HELM_ARCH="amd64" ;;
    arm64|aarch64) HELM_ARCH="arm64" ;;
    *) HELM_ARCH="amd64" ;;
esac

HELM_VERSION=$(curl -s https://api.github.com/repos/helm/helm/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\\1/' | head -1)
if [ -z "\$HELM_VERSION" ]; then
    HELM_VERSION="v3.20.0"
fi

HELM_S3_URL="${S3_BASE_URL}/tools/helm/\${HELM_ARCH}/helm-latest"
HELM_DOWNLOADED=false

# Try S3 first
if curl -f -s -L -o "${helmPath}" "\${HELM_S3_URL}"; then
    chmod +x "${helmPath}"
    # Verify it's a valid binary
    if "${helmPath}" version --client --short >/dev/null 2>&1; then
        HELM_DOWNLOADED=true
        echo "✅ Helm downloaded from S3 (version \${HELM_VERSION})"
    else
        echo "⚠️  Downloaded file from S3 is not valid, trying fallback..."
        rm -f "${helmPath}"
    fi
fi

# Fallback to original source if S3 failed
if [ "\${HELM_DOWNLOADED}" = "false" ]; then
    echo "⚠️  S3 download failed, trying fallback..."
    HELM_URL="https://get.helm.sh/helm-\${HELM_VERSION}-linux-\${HELM_ARCH}.tar.gz"
    
    if ! curl -f -s -L -o helm.tar.gz "\${HELM_URL}"; then
        echo "❌ Failed to download Helm from both S3 and fallback"
        exit 1
    fi
    
    if ! tar -xzf helm.tar.gz -C "${toolsDir}" --strip-components=1 "linux-\${HELM_ARCH}/helm" 2>/dev/null; then
        echo "❌ Failed to extract Helm binary"
        rm -f helm.tar.gz
        exit 1
    fi
    rm -f helm.tar.gz
    chmod +x "${helmPath}"
    echo "✅ Helm downloaded from fallback source (version \${HELM_VERSION})"
fi

# Execute the helm command
echo "🚀 Executing Helm command..."
${helmCommand}
`;

    await writeFile(scriptPath, scriptContent, { mode: 0o744 });
}

/**
 * Executes the helm command with timeout and proper error handling
 * @param {string} scriptPath - Path to the execution script
 * @returns {Promise<string>} The output of the command
 */
function executeHelmCommand(scriptPath) {
    return new Promise((resolve, reject) => {
        const timeoutMs = parseInt(process.env.INPUT_TIMEOUT || DEFAULT_TIMEOUT_MS.toString(), 10);
        const childProcess = execFile(scriptPath);
        let output = '';
        let errorOutput = '';
        let timeoutId;

        // Set timeout
        timeoutId = setTimeout(() => {
            logError(`Command execution timed out after ${timeoutMs / 1000} seconds`);
            childProcess.kill('SIGTERM');
            
            // Force kill after 5 seconds if still running
            setTimeout(() => {
                if (!childProcess.killed) {
                    childProcess.kill('SIGKILL');
                }
            }, 5000);
            
            reject(new Error(`Process timed out after ${timeoutMs / 1000} seconds`));
        }, timeoutMs);

        // Handle stdout
        childProcess.stdout.on('data', (data) => {
            const str = data.toString();
            process.stdout.write(str);
            output += str;
        });

        // Handle stderr
        childProcess.stderr.on('data', (data) => {
            const str = data.toString();
            process.stderr.write(str);
            errorOutput += str;
        });

        // Handle process exit
        childProcess.on('exit', (code) => {
            clearTimeout(timeoutId);
            const fullOutput = output + errorOutput;
            
            if (code === 0) {
                resolve(fullOutput);
            } else {
                const errorMessage = `Process exited with code ${code}`;
                logError(errorMessage);
                reject(new Error(`${errorMessage}\n${fullOutput}`));
            }
        });

        // Handle process errors
        childProcess.on('error', (error) => {
            clearTimeout(timeoutId);
            logError(`Failed to start process: ${error.message}`);
            reject(new Error(`Process error: ${error.message}`));
        });
    });
}

/**
 * Writes the helm output to GitHub Actions output
 * @param {string} output - The output to write
 * @returns {Promise<void>}
 */
async function writeGitHubOutput(output) {
    if (!process.env.GITHUB_OUTPUT) {
        return;
    }

    // Escape special characters for GitHub Actions output
    const escapedOutput = output
        .trim()
        .replace(/%/g, '%25')
        .replace(/\n/g, '%0A')
        .replace(/\r/g, '%0D');

    await appendFile(process.env.GITHUB_OUTPUT, `helm_output=${escapedOutput}\n`);
}

/**
 * Cleans up temporary files and directories
 * @param {Object} cleanupPaths - Object containing paths to clean up
 * @returns {Promise<void>}
 */
async function cleanup(cleanupPaths) {
    logInfo('Cleaning up temporary files...');

    try {
        // Remove execution script
        if (cleanupPaths.execScript) {
            await unlink(cleanupPaths.execScript);
            logSuccess('Execution script removed');
        }

        // Remove docker kubeconfig
        if (cleanupPaths.dockerKubeConfig) {
            await unlink(cleanupPaths.dockerKubeConfig);
            logSuccess('Docker kubeconfig removed');
        }

        // Remove tools directory
        if (cleanupPaths.toolsDir && fs.existsSync(cleanupPaths.toolsDir)) {
            fs.rmSync(cleanupPaths.toolsDir, { recursive: true, force: true });
            logSuccess('Tools directory removed');
        }

        // Handle kubeconfig cleanup
        if (cleanupPaths.shouldRemoveKubeConfig && cleanupPaths.kubeConfigPath) {
            await unlink(cleanupPaths.kubeConfigPath);
            logSuccess('Kubeconfig removed');
        }

        // Restore backed up kubeconfig
        if (cleanupPaths.shouldRestoreKubeConfig && cleanupPaths.backupPath && cleanupPaths.kubeConfigPath) {
            if (fs.existsSync(cleanupPaths.backupPath)) {
                await rename(cleanupPaths.backupPath, cleanupPaths.kubeConfigPath);
                logSuccess('Kubeconfig restored');
            }
        }
    } catch (error) {
        logError(`Cleanup error: ${error.message}`);
        // Don't throw - cleanup errors shouldn't fail the action
    }
}

/**
 * Main execution function
 */
async function main() {
    let cleanupPaths = {
        execScript: null,
        dockerKubeConfig: null,
        toolsDir: null,
        kubeConfigPath: null,
        backupPath: null,
        shouldRemoveKubeConfig: false,
        shouldRestoreKubeConfig: false
    };

    try {
        // Initialize
        logInfo(`Working directory: ${process.cwd()}`);
        tmp.setGracefulCleanup();

        // Validate inputs
        validateInputs();

        // Setup paths
        const homedir = os.homedir();
        const tempdir = os.tmpdir();
        const kubeConfigPath = path.join(homedir, '.kube', 'config');
        const backupPath = `${kubeConfigPath}_backup_${generateRandomString()}`;
        const toolsDir = path.join(tempdir, `helm-tools-${generateRandomString()}`);
        const dockerKubeConfigPath = path.join(toolsDir, 'config');

        // Create tools directory
        await mkdir(toolsDir, { recursive: true, mode: 0o755 });

        // Setup kubeconfig
        const kubeConfigStatus = await setupKubeConfig(kubeConfigPath, backupPath);
        cleanupPaths.kubeConfigPath = kubeConfigPath;
        cleanupPaths.backupPath = backupPath;
        cleanupPaths.shouldRemoveKubeConfig = !kubeConfigStatus.exists || 
            (kubeConfigStatus.exists && process.env.INPUT_OVERRULE_EXISTING_KUBECONFIG === 'true');
        cleanupPaths.shouldRestoreKubeConfig = kubeConfigStatus.wasBackedUp;

        // Copy kubeconfig to tools directory
        await writeFile(dockerKubeConfigPath, await readFile(kubeConfigPath), { mode: 0o644 });

        // Create execution script
        const execScript = tmp.fileSync({
            mode: 0o744,
            prefix: 'helm-exec-',
            postfix: '.sh',
            discardDescriptor: true
        });

        await createExecutionScript(execScript.name, toolsDir, process.env.INPUT_EXEC);
        cleanupPaths.execScript = execScript.name;
        cleanupPaths.dockerKubeConfig = dockerKubeConfigPath;
        cleanupPaths.toolsDir = toolsDir;

        // Wait for files to be ready
        await waitFile({
            resources: [kubeConfigPath, execScript.name]
        });

        // Execute helm command
        logInfo('Executing Helm command...');
        const result = await executeHelmCommand(execScript.name);
        
        // Write output to GitHub Actions
        await writeGitHubOutput(result);
        
        logSuccess('Helm command executed successfully');
    } catch (error) {
        logError(error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exitCode = 1;
    } finally {
        await cleanup(cleanupPaths);
    }
}

// Execute main function
if (require.main === module) {
    main().catch((error) => {
        logError(`Unhandled error: ${error.message}`);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    });
}

module.exports = { main };
