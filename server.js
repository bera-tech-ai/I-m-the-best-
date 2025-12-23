const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const winston = require('winston');
const path = require('path');
require('dotenv').config();

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' folder

// Rate limiting
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 OTP requests per windowMs
  message: {
    error: 'Too many OTP requests from this IP, please try again after 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Input validation schemas
const emailSchema = Joi.object({
  email: Joi.string().email().required()
});

const otpSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().pattern(/^\d{6}$/).required()
});

// Store OTPs (use Redis in production)
const otpStore = new Map();

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Verify transporter configuration
transporter.verify(function(error, success) {
  if (error) {
    logger.error('Mail transporter configuration error:', error);
  } else {
    logger.info('Mail transporter is ready to send messages');
  }
});

// Generate 6-digit OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// ========== ROUTES ==========

// 1. Root route - Serve HTML frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'OTP Verification Service',
    version: '1.0.0'
  });
});

// 3. API Documentation
app.get('/api-docs', (req, res) => {
  res.json({
    endpoints: [
      {
        method: 'POST',
        path: '/api/send-otp',
        description: 'Send OTP to email',
        body: { email: 'user@example.com' }
      },
      {
        method: 'POST',
        path: '/api/verify-otp',
        description: 'Verify OTP',
        body: { email: 'user@example.com', otp: '123456' }
      },
      {
        method: 'GET',
        path: '/health',
        description: 'Service health check'
      }
    ]
  });
});

// 4. Send OTP endpoint with rate limiting
app.post('/api/send-otp', otpLimiter, async (req, res) => {
  try {
    // Validate input
    const { error, value } = emailSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(detail => detail.message)
      });
    }

    const { email } = value;
    
    // Generate OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    
    // Store OTP
    otpStore.set(email, {
      otp,
      expiresAt,
      attempts: 0
    });

    // Email template
    const mailOptions = {
      from: {
        name: 'OTP Verification Service',
        address: process.env.GMAIL_USER
      },
      to: email,
      subject: 'Your OTP Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
          <h2 style="color: #333; text-align: center;">OTP Verification</h2>
          <p style="color: #666; font-size: 16px; line-height: 1.5;">
            Your One-Time Password (OTP) for verification is:
          </p>
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; text-align: center; font-size: 36px; font-weight: bold; letter-spacing: 15px; margin: 30px 0; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            ${otp}
          </div>
          <p style="color: #999; font-size: 14px; text-align: center;">
            This OTP will expire in 5 minutes. Do not share this code with anyone.
          </p>
          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
            <p style="color: #888; font-size: 12px;">
              If you didn't request this code, please ignore this email or contact support if you have concerns.
            </p>
          </div>
        </div>
      `,
      text: `Your OTP verification code is: ${otp}. This code will expire in 5 minutes.`
    };

    // Send email
    await transporter.sendMail(mailOptions);
    
    logger.info(`OTP sent to ${email}`);
    
    res.json({
      success: true,
      message: 'OTP sent successfully',
      expiresIn: '5 minutes'
    });
    
  } catch (error) {
    logger.error('Error sending OTP:', error);
    
    if (error.code === 'EAUTH') {
      return res.status(500).json({
        error: 'Authentication failed. Please check email configuration.'
      });
    }
    
    res.status(500).json({
      error: 'Failed to send OTP. Please try again later.'
    });
  }
});

// 5. Verify OTP endpoint
app.post('/api/verify-otp', async (req, res) => {
  try {
    // Validate input
    const { error, value } = otpSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(detail => detail.message)
      });
    }

    const { email, otp } = value;
    
    const storedData = otpStore.get(email);
    
    if (!storedData) {
      return res.status(400).json({
        error: 'No OTP found for this email or OTP has expired'
      });
    }

    // Check if OTP has expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(email);
      logger.warn(`Expired OTP attempt for ${email}`);
      return res.status(400).json({
        error: 'OTP has expired. Please request a new one.'
      });
    }

    // Check max attempts (3 attempts allowed)
    if (storedData.attempts >= 3) {
      otpStore.delete(email);
      logger.warn(`Max OTP attempts exceeded for ${email}`);
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
      logger.info(`OTP verified successfully for ${email}`);
      
      return res.json({
        success: true,
        message: 'OTP verified successfully',
        token: crypto.randomBytes(32).toString('hex') // Return a verification token
      });
    } else {
      logger.warn(`Invalid OTP attempt for ${email}. Attempt ${storedData.attempts}/3`);
      
      const remainingAttempts = 3 - storedData.attempts;
      
      return res.status(400).json({
        error: 'Invalid OTP',
        remainingAttempts: remainingAttempts > 0 ? remainingAttempts : 0
      });
    }
    
  } catch (error) {
    logger.error('Error verifying OTP:', error);
    res.status(500).json({
      error: 'Failed to verify OTP. Please try again.'
    });
  }
});

// 6. 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    requestedUrl: req.url,
    method: req.method,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /api-docs',
      'POST /api/send-otp',
      'POST /api/verify-otp'
    ]
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`\n🚀 Server started!`);
  console.log(`👉 Open your browser and visit: http://localhost:${PORT}`);
  console.log(`📧 Make sure GMAIL_USER and GMAIL_APP_PASSWORD are set in .env file\n`);
});

module.exports = app;
