let currentTab = 'send';
let emailForOTP = '';

// Switch between tabs
function switchTab(tabName) {
    currentTab = tabName;
    
    // Update tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // Activate selected tab
    event.target.classList.add('active');
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // If switching to verify tab, copy email from send tab if available
    if (tabName === 'verify' && emailForOTP) {
        document.getElementById('verify-email').value = emailForOTP;
    }
}

// Format OTP input (auto-add spaces, only numbers)
function formatOTP(input) {
    let value = input.value.replace(/\D/g, '');
    if (value.length > 6) value = value.substring(0, 6);
    input.value = value;
    
    // Auto-focus next input (for better UX if using multiple inputs)
    if (value.length === 6) {
        input.blur();
    }
}

// Copy OTP from clipboard
async function copyOTP() {
    try {
        const text = await navigator.clipboard.readText();
        const otp = text.replace(/\D/g, '').substring(0, 6);
        if (otp.length === 6) {
            document.getElementById('otp-code').value = otp;
            showMessage('OTP pasted from clipboard!', 'success');
        } else {
            showMessage('No valid OTP found in clipboard', 'error');
        }
    } catch (err) {
        showMessage('Failed to access clipboard', 'error');
    }
}

// Show message
function showMessage(text, type = 'info') {
    const messageDiv = document.getElementById('message');
    messageDiv.textContent = text;
    messageDiv.className = `message ${type}`;
    messageDiv.style.display = 'block';
    
    // Auto-hide success messages after 5 seconds
    if (type === 'success') {
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 5000);
    }
}

// Show loading state on button
function setButtonLoading(buttonId, isLoading) {
    const button = document.getElementById(buttonId);
    const originalText = button.innerHTML;
    
    if (isLoading) {
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> Processing...';
    } else {
        button.disabled = false;
        button.innerHTML = originalText.replace('<span class="spinner"></span> Processing...', 
            buttonId === 'send-btn' ? '<i class="fas fa-paper-plane"></i> Send OTP' : '<i class="fas fa-check-circle"></i> Verify OTP');
    }
}

// Send OTP
async function sendOTP() {
    const email = document.getElementById('email').value.trim();
    
    if (!email) {
        showMessage('Please enter your email address', 'error');
        return;
    }
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showMessage('Please enter a valid email address', 'error');
        return;
    }
    
    emailForOTP = email;
    setButtonLoading('send-btn', true);
    
    try {
        const response = await fetch('/api/send-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showMessage(`✅ ${data.message}. Check your email (${email})`, 'success');
            
            // Auto-switch to verify tab
            setTimeout(() => {
                document.querySelector('.tab-container button:nth-child(2)').click();
                document.getElementById('verify-email').value = email;
                document.getElementById('otp-code').focus();
            }, 1000);
            
        } else {
            showMessage(`❌ ${data.error || 'Failed to send OTP'}`, 'error');
        }
    } catch (error) {
        showMessage('❌ Network error. Please check your connection.', 'error');
        console.error('Error:', error);
    } finally {
        setButtonLoading('send-btn', false);
    }
}

// Verify OTP
async function verifyOTP() {
    const email = document.getElementById('verify-email').value.trim();
    const otp = document.getElementById('otp-code').value;
    
    if (!email) {
        showMessage('Please enter your email address', 'error');
        return;
    }
    
    if (!otp || otp.length !== 6) {
        showMessage('Please enter a valid 6-digit OTP', 'error');
        return;
    }
    
    setButtonLoading('verify-btn', true);
    
    try {
        const response = await fetch('/api/verify-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, otp })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showSuccessModal(data);
        } else {
            showMessage(`❌ ${data.error}`, 'error');
            updateAttemptsCounter(data.remainingAttempts);
        }
    } catch (error) {
        showMessage('❌ Network error. Please check your connection.', 'error');
        console.error('Error:', error);
    } finally {
        setButtonLoading('verify-btn', false);
    }
}

// Update attempts counter
function updateAttemptsCounter(remaining) {
    const attemptsElement = document.getElementById('attempts');
    if (remaining > 0) {
        attemptsElement.textContent = `Attempts remaining: ${remaining}`;
        attemptsElement.style.color = remaining > 1 ? '#28a745' : '#ffc107';
    } else {
        attemptsElement.textContent = 'No attempts remaining. Request new OTP.';
        attemptsElement.style.color = '#dc3545';
    }
}

// Show success modal
function showSuccessModal(data) {
    document.getElementById('success-message').textContent = data.message;
    document.getElementById('verification-token').textContent = data.token;
    document.getElementById('success-modal').style.display = 'flex';
}

// Close modal
function closeModal() {
    document.getElementById('success-modal').style.display = 'none';
    
    // Reset form
    document.getElementById('verify-email').value = '';
    document.getElementById('otp-code').value = '';
    document.getElementById('email').value = '';
    emailForOTP = '';
    
    // Switch back to send tab
    document.querySelector('.tab-container button:nth-child(1)').click();
}

// Copy token to clipboard
async function copyToken() {
    const token = document.getElementById('verification-token').textContent;
    try {
        await navigator.clipboard.writeText(token);
        showMessage('Token copied to clipboard!', 'success');
    } catch (err) {
        showMessage('Failed to copy token', 'error');
    }
}

// Check server status
async function checkServerStatus() {
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('server-status');
    
    try {
        const response = await fetch('/health');
        if (response.ok) {
            statusIndicator.classList.add('connected');
            statusText.textContent = 'Server connected';
            statusText.style.color = '#51cf66';
        } else {
            throw new Error('Server error');
        }
    } catch (error) {
        statusIndicator.classList.remove('connected');
        statusText.textContent = 'Server disconnected';
        statusText.style.color = '#ff6b6b';
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    // Check server status every 30 seconds
    checkServerStatus();
    setInterval(checkServerStatus, 30000);
    
    // Add enter key support
    document.getElementById('email').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') sendOTP();
    });
    
    document.getElementById('otp-code').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') verifyOTP();
    });
    
    // Auto-format OTP input
    document.getElementById('otp-code').addEventListener('input', function(e) {
        formatOTP(e.target);
    });
});
