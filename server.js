const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store OTPs
const otpStore = new Map();

// SMTP Configuration with multiple fallbacks
let transporter = null;
let smtpEnabled = false;

const initializeSMTP = async () => {
  console.log('🔧 Initializing SMTP...');
  console.log('GMAIL_USER:', process.env.GMAIL_USER ? '✓ Set' : '✗ Not set');
  console.log('GMAIL_APP_PASSWORD:', process.env.GMAIL_APP_PASSWORD ? '✓ Set (length: ' + process.env.GMAIL_APP_PASSWORD.length + ')' : '✗ Not set');

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('⚠️  SMTP disabled: Missing credentials');
    return;
  }

  // Try different SMTP configurations
  const configs = [
    {
      name: 'Port 587 (TLS)',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000
    },
    {
      name: 'Port 465 (SSL)',
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000
    },
    {
      name: 'Port 25',
      host: 'smtp.gmail.com',
      port: 25,
      secure: false,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000
    }
  ];

  for (const config of configs) {
    try {
      console.log(`Trying ${config.name}...`);
      transporter = nodemailer.createTransport(config);
      
      // Test connection
      await transporter.verify();
      console.log(`✅ SMTP connected via ${config.name}`);
      smtpEnabled = true;
      return;
    } catch (error) {
      console.log(`❌ ${config.name} failed: ${error.message}`);
      transporter = null;
    }
  }
  
  console.log('❌ All SMTP configurations failed. Using console mode.');
};

// Initialize SMTP on startup
initializeSMTP();

// Generate OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// ========== ROUTES ==========

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    smtp: {
      enabled: smtpEnabled,
      user_set: !!process.env.GMAIL_USER,
      pass_set: !!process.env.GMAIL_APP_PASSWORD
    }
  });
});

// Send OTP
app.post('/api/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    
    // Store OTP
    otpStore.set(email, {
      otp,
      expiresAt,
      attempts: 0
    });

    console.log('\n' + '='.repeat(50));
    console.log('📧 OTP GENERATED');
    console.log('='.repeat(50));
    console.log(`Email: ${email}`);
    console.log(`OTP: ${otp}`);
    console.log(`Expires: ${new Date(expiresAt).toLocaleTimeString()}`);
    console.log('='.repeat(50) + '\n');

    // Try to send email if SMTP is enabled
    let emailSent = false;
    let emailError = null;
    
    if (smtpEnabled && transporter) {
      try {
        const mailOptions = {
          from: process.env.GMAIL_USER,
          to: email,
          subject: 'Your OTP Verification Code',
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
              <h2>Your OTP Verification Code</h2>
              <p>Use this code to verify your email:</p>
              <div style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #333; margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 10px; text-align: center;">
                ${otp}
              </div>
              <p>This code will expire in 5 minutes.</p>
              <p style="color: #666; font-size: 14px; margin-top: 30px;">
                If you didn't request this code, please ignore this email.
              </p>
            </div>
          `,
          text: `Your OTP verification code is: ${otp}\n\nThis code will expire in 5 minutes.\n\nIf you didn't request this code, please ignore this email.`
        };

        await transporter.sendMail(mailOptions);
        emailSent = true;
        console.log('✅ Email sent successfully');
      } catch (emailError) {
        console.error('❌ Email sending failed:', emailError.message);
        emailError = emailError.message;
      }
    } else {
      console.log('ℹ️  Email not sent (SMTP disabled)');
    }

    // Always respond with success, but include OTP in development
    const response = {
      success: true,
      message: emailSent 
        ? 'OTP sent to your email' 
        : 'OTP generated (check server console)',
      email: email
    };

    // Include OTP in development for testing
    if (process.env.NODE_ENV !== 'production') {
      response.debug = {
        otp: otp,
        expiresIn: '5 minutes',
        emailSent: emailSent,
        emailError: emailError
      };
    }

    res.json(response);
    
  } catch (error) {
    console.error('Error in /api/send-otp:', error);
    res.status(500).json({ 
      error: 'Failed to generate OTP',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

// Verify OTP
app.post('/api/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;
    
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const storedData = otpStore.get(email);
    
    if (!storedData) {
      return res.status(400).json({ 
        error: 'No OTP found for this email. Please request a new OTP.' 
      });
    }

    // Check if OTP has expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ 
        error: 'OTP has expired. Please request a new one.' 
      });
    }

    // Check max attempts (3 attempts allowed)
    if (storedData.attempts >= 3) {
      otpStore.delete(email);
      return res.status(400).json({ 
        error: 'Maximum OTP attempts exceeded. Please request a new OTP.' 
      });
    }

    // Increment attempts
    storedData.attempts += 1;
    otpStore.set(email, storedData);

    // Verify OTP
    if (storedData.otp === otp) {
      otpStore.delete(email);
      console.log(`✅ OTP verified for ${email}`);
      
      return res.json({
        success: true,
        message: 'OTP verified successfully!',
        token: crypto.randomBytes(32).toString('hex')
      });
    } else {
      const remainingAttempts = 3 - storedData.attempts;
      console.log(`❌ Invalid OTP attempt for ${email}. Attempts: ${storedData.attempts}/3`);
      
      return res.status(400).json({
        error: 'Invalid OTP',
        remainingAttempts: remainingAttempts > 0 ? remainingAttempts : 0
      });
    }
    
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Get OTP status (for debugging)
app.get('/api/debug/otps', (req, res) => {
  const otps = Array.from(otpStore.entries()).map(([email, data]) => ({
    email,
    otp: data.otp,
    expiresIn: Math.round((data.expiresAt - Date.now()) / 1000),
    attempts: data.attempts
  }));
  
  res.json({
    count: otps.length,
    otps: otps
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📧 SMTP Status: ${smtpEnabled ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`🔗 Open your browser to: http://localhost:${PORT}`);
  console.log('\n💡 TROUBLESHOOTING:');
  console.log('1. Click "Send OTP" button');
  console.log('2. Check server console for the OTP');
  console.log('3. Copy the OTP from console');
  console.log('4. Paste it in the verification form\n');
});
