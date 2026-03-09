// services/telebirr.js
const crypto = require('crypto');
const axios = require('axios');

class TelebirrPayment {
    constructor() {
        this.appId = process.env.TELEBIRR_APP_ID;
        this.appKey = process.env.TELEBIRR_APP_KEY;
        this.shortCode = process.env.TELEBIRR_SHORT_CODE;
        this.publicKey = process.env.TELEBIRR_PUBLIC_KEY;
        this.apiUrl = process.env.TELEBIRR_ENVIRONMENT === 'production' 
            ? 'https://openapi.telebirr.com' 
            : 'https://openapi.telebirr.com'; // Test URL
    }

    // Generate unique transaction ID
    generateTransactionId(userId, cardCount) {
        const timestamp = Date.now();
        const random = crypto.randomBytes(4).toString('hex');
        return `BINGO_${userId}_${timestamp}_${random}`;
    }

    // Encrypt data using RSA
    encryptData(data) {
        try {
            const buffer = Buffer.from(JSON.stringify(data));
            const encrypted = crypto.publicEncrypt(this.publicKey, buffer);
            return encrypted.toString('base64');
        } catch (error) {
            console.error('Encryption error:', error);
            throw error;
        }
    }

    // Generate signature
    generateSignature(data) {
        const sortedString = Object.keys(data)
            .sort()
            .map(key => `${key}=${data[key]}`)
            .join('&');
        
        return crypto
            .createHmac('sha256', this.appKey)
            .update(sortedString)
            .digest('hex')
            .toUpperCase();
    }

    // Create payment request
    async createPayment(userId, amount, cardCount, userName) {
        const transactionId = this.generateTransactionId(userId, cardCount);
        const timestamp = Date.now().toString();
        const nonce = crypto.randomBytes(16).toString('hex');

        // Prepare payment data according to Telebirr spec
        const paymentData = {
            appId: this.appId,
            shortCode: this.shortCode,
            nonce: nonce,
            outTradeNo: transactionId,
            returnUrl: process.env.TELEBIRR_RETURN_URL,
            subject: `Bingo Cards - ${cardCount} pcs`,
            timeoutExpress: '30m',
            timestamp: timestamp,
            totalAmount: amount.toString(),
            receiveName: userName || 'Bingo Player',
            notifyUrl: process.env.TELEBIRR_NOTIFY_URL,
            paymentMethod: 'telebirr'
        };

        try {
            // Generate signature
            const signature = this.generateSignature(paymentData);

            // Prepare request body
            const requestBody = {
                appId: this.appId,
                sign: signature,
                encryptData: this.encryptData(paymentData)
            };

            // Make API request
            const response = await axios.post(
                `${this.apiUrl}/api/web/payment`,
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data && response.data.code === 0) {
                return {
                    success: true,
                    toPayUrl: response.data.data.toPayUrl,
                    transactionId: transactionId,
                    paymentData: paymentData
                };
            } else {
                return {
                    success: false,
                    error: response.data.msg || 'Payment creation failed'
                };
            }
        } catch (error) {
            console.error('Telebirr payment creation failed:', error);
            return {
                success: false,
                error: error.response?.data?.msg || error.message
            };
        }
    }

    // Verify payment notification
    verifyNotification(notificationData) {
        try {
            // Verify signature
            const receivedSign = notificationData.sign;
            const verifyData = { ...notificationData };
            delete verifyData.sign;
            
            const calculatedSign = this.generateSignature(verifyData);
            
            if (receivedSign !== calculatedSign) {
                return {
                    success: false,
                    error: 'Invalid signature'
                };
            }

            // Decrypt data if encrypted
            let paymentData = notificationData;
            if (notificationData.encryptData) {
                // Decrypt logic here if needed
            }

            return {
                success: true,
                transactionId: notificationData.outTradeNo,
                amount: notificationData.totalAmount,
                status: notificationData.tradeStatus,
                paymentTime: notificationData.paymentTime
            };
        } catch (error) {
            console.error('Notification verification failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Check payment status
    async checkPaymentStatus(transactionId) {
        try {
            const timestamp = Date.now().toString();
            const nonce = crypto.randomBytes(16).toString('hex');
            
            const queryData = {
                appId: this.appId,
                outTradeNo: transactionId,
                timestamp: timestamp,
                nonce: nonce
            };

            const signature = this.generateSignature(queryData);

            const response = await axios.post(
                `${this.apiUrl}/api/query/payment`,
                {
                    appId: this.appId,
                    sign: signature,
                    encryptData: this.encryptData(queryData)
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data && response.data.code === 0) {
                return {
                    success: true,
                    status: response.data.data.tradeStatus,
                    amount: response.data.data.totalAmount,
                    paymentTime: response.data.data.paymentTime
                };
            } else {
                return {
                    success: false,
                    error: response.data.msg || 'Status check failed'
                };
            }
        } catch (error) {
            console.error('Status check failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Refund payment
    async refundPayment(transactionId, amount) {
        try {
            const timestamp = Date.now().toString();
            const nonce = crypto.randomBytes(16).toString('hex');
            
            const refundData = {
                appId: this.appId,
                outTradeNo: transactionId,
                refundAmount: amount.toString(),
                timestamp: timestamp,
                nonce: nonce
            };

            const signature = this.generateSignature(refundData);

            const response = await axios.post(
                `${this.apiUrl}/api/refund/payment`,
                {
                    appId: this.appId,
                    sign: signature,
                    encryptData: this.encryptData(refundData)
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data && response.data.code === 0) {
                return {
                    success: true,
                    refundId: response.data.data.refundId
                };
            } else {
                return {
                    success: false,
                    error: response.data.msg || 'Refund failed'
                };
            }
        } catch (error) {
            console.error('Refund failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = new TelebirrPayment();