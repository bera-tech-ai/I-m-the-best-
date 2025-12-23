const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

// Store OTPs temporarily (use Redis in production)
const otpStore = new Map();

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER, // Your Gmail address
        pass: process.env.GMAIL_APP_PASSWORD // App password
    }
});

// Generate 6-digit OTP
function generateOTP() {
    return crypto.randomInt(100000, 999999).toString();
}

// Send OTP to email
app.post('/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Generate OTP
        const otp = generateOTP();
        
        // Store OTP with expiration (5 minutes)
        otpStore.set(email, {
            otp,
            expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        });

        // Email options
        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: email,
            subject: 'Your OTP Code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2>OTP Verification</h2>
                    <p>Your One-Time Password (OTP) is:</p>
                    <div style="background-color: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; letter-spacing: 10px; font-weight: bold; margin: 20px 0;">
                        ${otp}
                    </div>
                    <p>This OTP will expire in 5 minutes.</p>
                    <p>If you didn't request this code, please ignore this email.</p>
                </div>
            `
        };

        // Send email
        await transporter.sendMail(mailOptions);
        
        res.json({ 
            success: true, 
            message: 'OTP sent successfully' 
        });
        
    } catch (error) {
        console.error('Error sending OTP:', error);
        res.status(500).json({ 
            error: 'Failed to send OTP' 
        });
    }
});

// Verify OTP
app.post('/verify-otp', (req, res) => {
    try {
        const { email, otp } = req.body;
        
        if (!email || !otp) {
            return res.status(400).json({ 
                error: 'Email and OTP are required' 
            });
        }

        const storedData = otpStore.get(email);
        
        if (!storedData) {
            return res.status(400).json({ 
                error: 'No OTP found for this email or OTP expired' 
            });
        }

        // Check if OTP has expired
        if (Date.now() > storedData.expiresAt) {
            otpStore.delete(email);
            return res.status(400).json({ 
                error: 'OTP has expired' 
            });
        }

        // Verify OTP
        if (storedData.otp === otp) {
            otpStore.delete(email); // Remove OTP after successful verification
            return res.json({ 
                success: true, 
                message: 'OTP verified successfully' 
            });
        } else {
            return res.status(400).json({ 
                error: 'Invalid OTP' 
            });
        }
        
    } catch (error) {
        console.error('Error verifying OTP:', error);
        res.status(500).json({ 
            error: 'Failed to verify OTP' 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
