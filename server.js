const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests. Try again later.' }
});

// Store OTPs (in production, use Redis)
const otpStore = new Map();

// ========== SMTP CONFIGURATION FOR RENDER ==========
const getTransporter = () => {
  // Configuration for cloud platforms
  const config = {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    },
    // Timeout settings for cloud environments
    connectionTimeout: 30000, // 30 seconds
    greetingTimeout: 30000,   // 30 seconds
    socketTimeout: 30000,     // 30 seconds
    // TLS settings
    tls: {
      rejectUnauthorized: false // Required for Render/Heroku
    },
    // Debug logging
    debug: process.env.NODE_ENV === 'development',
    logger: process.env.NODE_ENV === 'development'
  };

  console.log('SMTP Configuration:', {
    host: config.host,
    port: config.port,
    user: process.env.GMAIL_USER ? 'Set' : 'Not Set',
    pass: process.env.GMAIL_APP_PASSWORD ? 'Set' : 'Not Set'
  });

  return nodemailer.createTransport(config);
};

// Test SMTP connection on startup
const testSMTPConnection = async () => {
  const transporter = getTransporter();
  
  try {
    await transporter.verify();
    console.log('✅ SMTP connection successful!');
    return transporter;
  } catch (error) {
    console.error('❌ SMTP connection failed:', error.message);
    console.log('\n🔧 Troubleshooting steps:');
    console.log('1. Check if GMAIL_USER and GMAIL_APP_PASSWORD are set');
    console.log('2. Verify the App Password is correct (16 characters)');
    console.log('3. Enable 2-Step Verification in Google Account');
    console.log('4. Check if "Less secure app access" is enabled (if not using App Password)');
    console.log('5. Ensure no firewall is blocking port 587');
    return null;
  }
};

// Initialize transporter
let transporter = null;
testSMTPConnection().then(t => {
  transporter = t;
  if (transporter) {
    console.log('📧 Email service is ready');
  }
});

// Generate OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// ========== ROUTES ==========

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check with SMTP status
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    smtp: {
      configured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
      user_set: !!process.env.GMAIL_USER,
      pass_set: !!process.env.GMAIL_APP_PASSWORD,
      connected: !!transporter
    }
  });
});

// Send OTP
app.post('/api/send-otp', otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if SMTP is configured
    if (!transporter) {
      console.error('SMTP not configured');
      return res.status(503).json({ 
        error: 'Email service not configured. Please check server logs.' 
      });
    }

    // Generate OTP
    const otp = generateOTP();
    otpStore.set(email, {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000,
      attempts: 0
    });

    console.log(`Generated OTP for ${email}: ${otp}`);

    // Send email
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: 'Your OTP Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Your OTP Code</h2>
          <p>Use this code to verify your email:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 10px; margin: 20px 0;">
            ${otp}
          </div>
          <p>This code expires in 5 minutes.</p>
        </div>
      `,
      text: `Your OTP code is: ${otp}. It expires in 5 minutes.`
    };

    await transporter.sendMail(mailOptions);
    
    res.json({ 
      success: true, 
      message: 'OTP sent successfully',
      // For debugging on Render, you might want to include the OTP
      // Remove this in production!
      debug: process.env.NODE_ENV === 'development' ? { otp } : undefined
    });
    
  } catch (error) {
    console.error('Error sending OTP:', error);
    
    // More specific error messages
    if (error.code === 'EAUTH') {
      return res.status(500).json({ 
        error: 'Email authentication failed. Check Gmail credentials.' 
      });
    }
    
    if (error.code === 'ETIMEDOUT') {
      return res.status(500).json({ 
        error: 'Email service timeout. Please try again.' 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to send OTP. Please try again later.' 
    });
  }
});

// Verify OTP
app.post('/api/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;
    
    const storedData = otpStore.get(email);
    
    if (!storedData) {
      return res.status(400).json({ error: 'OTP not found or expired' });
    }
    
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ error: 'OTP expired' });
    }
    
    if (storedData.otp === otp) {
      otpStore.delete(email);
      return res.json({ 
        success: true, 
        message: 'OTP verified successfully' 
      });
    } else {
      storedData.attempts += 1;
      otpStore.set(email, storedData);
      
      if (storedData.attempts >= 3) {
        otpStore.delete(email);
        return res.status(400).json({ 
          error: 'Too many failed attempts. Request a new OTP.' 
        });
      }
      
      return res.status(400).json({ 
        error: 'Invalid OTP',
        attempts: storedData.attempts 
      });
    }
    
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Port configuration
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Make sure to set GMAIL_USER and GMAIL_APP_PASSWORD in Render environment`);
  console.log(`🔗 Visit: https://dashboard.render.com/ to set environment variables`);
});
