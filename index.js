// index.js - Main Telegram Bot File with Telebirr Integration
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Import Telebirr service
const telebirrService = require('./services/telebirr');

// ==================== CONFIGURATION ====================
const token = process.env.BOT_TOKEN;
const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './bingo.db';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Validate bot token
if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
    console.error('❌ Please set your BOT_TOKEN in .env file!');
    process.exit(1);
}

// Initialize bot
const bot = new TelegramBot(token, { 
    polling: true,
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// ==================== LOGGER SETUP ====================
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

// ==================== DATABASE SETUP ====================
let db;

async function initializeDatabase() {
    try {
        // Ensure data directory exists
        const dataDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                balance INTEGER DEFAULT ${process.env.DEFAULT_BALANCE || 1000},
                total_wins INTEGER DEFAULT 0,
                total_cards_bought INTEGER DEFAULT 0,
                total_spent INTEGER DEFAULT 0,
                total_won INTEGER DEFAULT 0,
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS games (
                game_id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_type TEXT DEFAULT 'full house',
                prize_amount INTEGER DEFAULT ${process.env.DEFAULT_PRIZE || 2000},
                card_price INTEGER DEFAULT ${process.env.DEFAULT_CARD_PRICE || 10},
                status TEXT DEFAULT 'waiting',
                called_numbers TEXT DEFAULT '[]',
                winners TEXT DEFAULT '[]',
                total_players INTEGER DEFAULT 0,
                total_cards INTEGER DEFAULT 0,
                started_by INTEGER,
                started_at DATETIME,
                ended_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS cards (
                card_id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                game_id INTEGER,
                card_number INTEGER UNIQUE,
                numbers TEXT,
                is_winner BOOLEAN DEFAULT 0,
                marked_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(user_id),
                FOREIGN KEY (game_id) REFERENCES games(game_id)
            );

            CREATE TABLE IF NOT EXISTS transactions (
                transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                amount INTEGER,
                type TEXT CHECK(type IN ('purchase', 'win', 'deposit', 'refund')),
                game_id INTEGER,
                description TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(user_id),
                FOREIGN KEY (game_id) REFERENCES games(game_id)
            );

            CREATE TABLE IF NOT EXISTS pending_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_id TEXT UNIQUE,
                user_id INTEGER,
                amount INTEGER,
                card_count INTEGER,
                cards TEXT,
                status TEXT DEFAULT 'pending',
                telebirr_trade_no TEXT,
                created_at DATETIME,
                completed_at DATETIME,
                verified_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            );

            CREATE TABLE IF NOT EXISTS called_numbers_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER,
                number INTEGER,
                called_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (game_id) REFERENCES games(game_id)
            );

            CREATE INDEX IF NOT EXISTS idx_cards_user_game ON cards(user_id, game_id);
            CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
            CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
            CREATE INDEX IF NOT EXISTS idx_pending_transactions ON pending_transactions(status, created_at);
        `);

        logger.info('✅ Database initialized successfully');
    } catch (error) {
        logger.error('❌ Database initialization failed:', error);
        process.exit(1);
    }
}

// ==================== EXPRESS & SOCKET.IO SETUP ====================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));
app.use(express.static(path.join(__dirname, 'public')));

// Serve templates
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.get('/bingo-webapp', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        bot: bot.isPolling() ? 'running' : 'stopped'
    });
});

// ==================== TELEBIRR PAYMENT ROUTES ====================

// Initiate payment for card purchase
app.post('/api/create-payment', async (req, res) => {
    try {
        const { userId, cardCount, amount, userName, cards } = req.body;
        
        if (!userId || !cardCount || !amount || cardCount < 1) {
            return res.status(400).json({ error: 'Invalid request data' });
        }

        // Check if user exists
        let user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
        if (!user) {
            // Auto-register user
            await db.run(
                'INSERT INTO users (user_id, username, balance) VALUES (?, ?, ?)',
                [userId, userName || `user_${userId}`, 1000]
            );
        }

        // Create Telebirr payment
        const payment = await telebirrService.createPayment(
            userId, 
            amount, 
            cardCount, 
            userName
        );

        if (payment.success) {
            // Store transaction in database
            await db.run(
                `INSERT INTO pending_transactions 
                (transaction_id, user_id, amount, card_count, cards, status, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [payment.transactionId, userId, amount, cardCount, JSON.stringify(cards), 'pending', new Date().toISOString()]
            );

            res.json({
                success: true,
                paymentUrl: payment.toPayUrl,
                transactionId: payment.transactionId
            });
        } else {
            res.status(500).json({ error: payment.error });
        }
    } catch (error) {
        logger.error('Payment creation error:', error);
        res.status(500).json({ error: 'Payment creation failed' });
    }
});

// Payment success return URL
app.get('/payment/success', async (req, res) => {
    try {
        const { outTradeNo, totalAmount, tradeStatus, paymentTime } = req.query;
        
        logger.info(`Payment callback received: ${outTradeNo}, status: ${tradeStatus}`);
        
        if (tradeStatus === 'SUCCESS' || tradeStatus === 'SUCCESSFUL') {
            // Find pending transaction
            const transaction = await db.get(
                'SELECT * FROM pending_transactions WHERE transaction_id = ?',
                outTradeNo
            );

            if (transaction && transaction.status === 'pending') {
                // Parse cards from transaction
                const cards = JSON.parse(transaction.cards || '[]');
                
                // Get current game
                const game = await db.get('SELECT * FROM games WHERE status = "active" ORDER BY game_id DESC LIMIT 1');
                
                if (game) {
                    // Generate and save cards
                    const cardNumbers = [];
                    for (const cardId of cards) {
                        const cardNumbersData = generateBingoCard(cardId);
                        await db.run(
                            'INSERT INTO cards (user_id, game_id, card_number, numbers) VALUES (?, ?, ?, ?)',
                            [transaction.user_id, game.game_id, cardId, JSON.stringify(cardNumbersData)]
                        );
                        cardNumbers.push(cardId);
                    }
                    
                    // Update user balance
                    await db.run(
                        `UPDATE users SET 
                            balance = balance + ?, 
                            total_cards_bought = total_cards_bought + ?,
                            total_spent = total_spent + ?
                        WHERE user_id = ?`,
                        [transaction.amount, cards.length, transaction.amount, transaction.user_id]
                    );

                    // Record transaction
                    await db.run(
                        `INSERT INTO transactions 
                        (user_id, amount, type, game_id, description) 
                        VALUES (?, ?, ?, ?, ?)`,
                        [transaction.user_id, transaction.amount, 'deposit', game.game_id, 
                         `Telebirr deposit for ${cards.length} cards`]
                    );

                    // Mark transaction as completed
                    await db.run(
                        `UPDATE pending_transactions 
                        SET status = 'completed', completed_at = ?, telebirr_trade_no = ? 
                        WHERE transaction_id = ?`,
                        [new Date().toISOString(), outTradeNo, outTradeNo]
                    );

                    // Update game stats
                    await updateGameStats(game.game_id);

                    // Notify via socket if user is connected
                    io.emit('payment_completed', {
                        userId: transaction.user_id,
                        transactionId: outTradeNo,
                        cards: cards,
                        newBalance: (await db.get('SELECT balance FROM users WHERE user_id = ?', transaction.user_id)).balance
                    });
                }

                // Send success page
                res.send(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Payment Successful - MK Bingo</title>
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <style>
                            body {
                                margin: 0;
                                padding: 20px;
                                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                                background: linear-gradient(135deg, #1a2a6c, #b21f1f, #fdbb2d);
                                min-height: 100vh;
                                color: white;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            }
                            .success-card {
                                background: rgba(255,255,255,0.1);
                                backdrop-filter: blur(15px);
                                border: 2px solid rgba(255,255,255,0.2);
                                border-radius: 30px;
                                padding: 40px;
                                max-width: 500px;
                                text-align: center;
                                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                            }
                            h1 {
                                color: gold;
                                font-size: 3em;
                                margin: 20px 0;
                                text-shadow: 0 0 20px gold;
                            }
                            .amount {
                                font-size: 2.5em;
                                font-weight: bold;
                                color: #4CAF50;
                                margin: 20px 0;
                            }
                            .button {
                                background: gold;
                                color: black;
                                border: none;
                                padding: 18px 40px;
                                font-size: 1.2em;
                                font-weight: bold;
                                border-radius: 50px;
                                cursor: pointer;
                                margin-top: 30px;
                                transition: transform 0.3s;
                                text-decoration: none;
                                display: inline-block;
                            }
                            .button:hover {
                                transform: translateY(-3px);
                                box-shadow: 0 10px 20px rgba(255,215,0,0.3);
                            }
                            .checkmark {
                                width: 100px;
                                height: 100px;
                                border-radius: 50%;
                                background: #4CAF50;
                                color: white;
                                font-size: 60px;
                                line-height: 100px;
                                margin: 0 auto 20px;
                                animation: scaleIn 0.5s ease;
                            }
                            @keyframes scaleIn {
                                0% { transform: scale(0); }
                                70% { transform: scale(1.2); }
                                100% { transform: scale(1); }
                            }
                        </style>
                    </head>
                    <body>
                        <div class="success-card">
                            <div class="checkmark">✓</div>
                            <h1>✅ ክፍያ ተሳክቷል!</h1>
                            <p style="font-size: 1.2em;">የክፍያ መጠን</p>
                            <div class="amount">${transaction.amount} ETB</div>
                            <p style="margin: 20px 0;">${transaction.card_count} ካርዶች በተሳካ ሁኔታ ተገዝተዋል</p>
                            <a href="/" class="button">ወደ ጨዋታው ተመለስ</a>
                        </div>
                        <script>
                            setTimeout(() => {
                                window.location.href = '/';
                            }, 5000);
                        </script>
                    </body>
                    </html>
                `);
            } else {
                res.redirect('/');
            }
        } else {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Payment Failed - MK Bingo</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body {
                            margin: 0;
                            padding: 20px;
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            background: linear-gradient(135deg, #1a2a6c, #b21f1f);
                            min-height: 100vh;
                            color: white;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        .error-card {
                            background: rgba(255,255,255,0.1);
                            backdrop-filter: blur(15px);
                            border: 2px solid rgba(255,0,0,0.3);
                            border-radius: 30px;
                            padding: 40px;
                            max-width: 500px;
                            text-align: center;
                        }
                        h1 {
                            color: #ff6b6b;
                            font-size: 2.5em;
                            margin: 20px 0;
                        }
                        .button {
                            background: white;
                            color: #b21f1f;
                            border: none;
                            padding: 15px 30px;
                            font-size: 1.1em;
                            font-weight: bold;
                            border-radius: 50px;
                            cursor: pointer;
                            margin-top: 20px;
                            text-decoration: none;
                            display: inline-block;
                        }
                    </style>
                </head>
                <body>
                    <div class="error-card">
                        <h1>❌ ክፍያ አልተሳካም</h1>
                        <p style="margin: 20px 0;">እባክዎ እንደገና ይሞክሩ ወይም ሌላ የክፍያ ዘዴ ይምረጡ</p>
                        <a href="/" class="button">ወደ ጨዋታው ተመለስ</a>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (error) {
        logger.error('Payment success handler error:', error);
        res.status(500).send('Internal error');
    }
});

// Payment notification webhook (server-to-server)
app.post('/payment/notify', async (req, res) => {
    try {
        const notification = req.body;
        logger.info('Payment notification received:', notification);
        
        // Verify the notification
        const verified = telebirrService.verifyNotification(notification);
        
        if (verified.success) {
            // Update transaction status
            await db.run(
                `UPDATE pending_transactions 
                SET status = 'verified', verified_at = ?, telebirr_trade_no = ? 
                WHERE transaction_id = ?`,
                [new Date().toISOString(), notification.outTradeNo, verified.transactionId]
            );

            // Send success response to Telebirr
            res.json({ code: 0, message: 'success' });
        } else {
            res.status(400).json({ code: 1, message: 'verification failed' });
        }
    } catch (error) {
        logger.error('Notification webhook error:', error);
        res.status(500).json({ code: 1, message: 'internal error' });
    }
});

// Check payment status endpoint
app.get('/api/payment-status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        
        const transaction = await db.get(
            'SELECT status FROM pending_transactions WHERE transaction_id = ?',
            transactionId
        );
        
        if (transaction) {
            res.json({ 
                success: true, 
                status: transaction.status 
            });
        } else {
            res.json({ 
                success: false, 
                error: 'Transaction not found' 
            });
        }
    } catch (error) {
        logger.error('Payment status check error:', error);
        res.status(500).json({ error: 'Status check failed' });
    }
});

// ==================== SOCKET.IO CONNECTION HANDLING ====================
io.on('connection', (socket) => {
    logger.info('📱 Web App connected:', socket.id);
    
    let currentUser = null;

    // Handle card purchase via balance
    socket.on('buy_card', async (data) => {
        try {
            const { user_id, cards, name } = data;
            currentUser = { id: user_id, name };
            
            // Check if user exists
            let user = await db.get('SELECT * FROM users WHERE user_id = ?', user_id);
            if (!user) {
                await db.run(
                    'INSERT INTO users (user_id, username, balance) VALUES (?, ?, ?)',
                    [user_id, name || `user_${user_id}`, 1000]
                );
                user = { user_id, balance: 1000 };
            }
            
            // Get current game
            const game = await db.get('SELECT * FROM games WHERE status = "active" ORDER BY game_id DESC LIMIT 1');
            if (!game) {
                socket.emit('error_message', 'No active game. Please wait for admin to start a new round.');
                return;
            }
            
            const totalCost = cards.length * game.card_price;
            
            if (user.balance < totalCost) {
                socket.emit('error_message', `Insufficient balance! Need ${totalCost} ETB`);
                return;
            }
            
            // Generate and save cards
            for (const cardNum of cards) {
                const cardNumbers = generateBingoCard(cardNum);
                await db.run(
                    'INSERT INTO cards (user_id, game_id, card_number, numbers) VALUES (?, ?, ?, ?)',
                    [user_id, game.game_id, cardNum, JSON.stringify(cardNumbers)]
                );
            }
            
            // Update user balance
            await db.run(
                'UPDATE users SET balance = balance - ?, total_cards_bought = total_cards_bought + ? WHERE user_id = ?',
                [totalCost, cards.length, user_id]
            );
            
            // Record transaction
            await db.run(
                'INSERT INTO transactions (user_id, amount, type, game_id, description) VALUES (?, ?, ?, ?, ?)',
                [user_id, -totalCost, 'purchase', game.game_id, `Bought ${cards.length} cards`]
            );
            
            // Mark cards as sold in grid
            socket.emit('card_locked', { cards });
            
            // Send success with cards data
            socket.emit('purchase_success', { 
                cards: cards,
                newBalance: user.balance - totalCost 
            });
            
            // Update game stats
            await updateGameStats(game.game_id);
            
            logger.info(`User ${user_id} bought ${cards.length} cards`);
            
        } catch (error) {
            logger.error('Web App purchase error:', error);
            socket.emit('error_message', 'Purchase failed. Please try again.');
        }
    });

    // Handle admin draw number
    socket.on('admin_draw_number', async () => {
        try {
            const game = await db.get('SELECT * FROM games WHERE status = "active" ORDER BY game_id DESC LIMIT 1');
            if (!game) {
                socket.emit('error_message', 'No active game');
                return;
            }
            
            const calledNumbers = JSON.parse(game.called_numbers);
            if (calledNumbers.length >= 75) {
                socket.emit('error_message', 'All numbers have been called');
                return;
            }
            
            // Generate next number
            let number;
            do {
                number = Math.floor(Math.random() * 75) + 1;
            } while (calledNumbers.includes(number));
            
            calledNumbers.push(number);
            
            // Update game
            await db.run(
                'UPDATE games SET called_numbers = ? WHERE game_id = ?',
                [JSON.stringify(calledNumbers), game.game_id]
            );
            
            // Broadcast to all connected clients
            io.emit('number_update', { 
                num: number, 
                count: calledNumbers.length,
                all_numbers: calledNumbers 
            });
            
            // Check for winners
            const newWinners = await checkWinners(game.game_id, number);
            
            // Log the number
            await db.run(
                'INSERT INTO called_numbers_log (game_id, number) VALUES (?, ?)',
                [game.game_id, number]
            );
            
            logger.info(`Number ${number} drawn via Web App`);
            
        } catch (error) {
            logger.error('Web App draw error:', error);
            socket.emit('error_message', 'Failed to draw number');
        }
    });

    // Handle admin start round
    socket.on('admin_start_round', async (data) => {
        try {
            const { price } = data;
            
            // End current active game
            await db.run('UPDATE games SET status = "ended", ended_at = ? WHERE status = "active"', 
                [new Date().toISOString()]);
            
            // Create new game
            const result = await db.run(
                `INSERT INTO games 
                    (game_type, prize_amount, card_price, status, started_at) 
                VALUES (?, ?, ?, ?, ?)`,
                ['full house', 
                 parseInt(process.env.DEFAULT_PRIZE || 2000), 
                 price || parseInt(process.env.DEFAULT_CARD_PRICE || 10), 
                 'active', 
                 new Date().toISOString()]
            );
            
            io.emit('new_round_started', { 
                game_id: result.lastID,
                card_price: price || parseInt(process.env.DEFAULT_CARD_PRICE || 10) 
            });
            
            logger.info('New round started via Web App');
            
        } catch (error) {
            logger.error('Web App start round error:', error);
            socket.emit('error_message', 'Failed to start round');
        }
    });

    // Handle bingo claim
    socket.on('claim_bingo', async (data) => {
        try {
            const { user_id, name } = data;
            
            // Get user's cards for current game
            const game = await db.get('SELECT * FROM games WHERE status = "active" ORDER BY game_id DESC LIMIT 1');
            if (!game) return;
            
            const userCards = await db.all(
                'SELECT * FROM cards WHERE user_id = ? AND game_id = ?',
                [user_id, game.game_id]
            );
            
            const calledNumbers = JSON.parse(game.called_numbers);
            let winningCard = null;
            
            // Check each card for win
            for (const card of userCards) {
                const numbers = JSON.parse(card.numbers);
                const win = checkCardForWin(numbers, calledNumbers, game.game_type);
                if (win) {
                    winningCard = { card, win };
                    break;
                }
            }
            
            if (winningCard) {
                // Check if already a winner
                const existingWinners = JSON.parse(game.winners);
                const alreadyWon = existingWinners.some(w => w.card_number === winningCard.card.card_number);
                
                if (!alreadyWon) {
                    // Add to winners
                    existingWinners.push({
                        card_number: winningCard.card.card_number,
                        win_type: winningCard.win.type,
                        user_id: user_id,
                        user_name: name,
                        called_at: new Date().toISOString()
                    });
                    
                    await db.run(
                        'UPDATE games SET winners = ? WHERE game_id = ?',
                        [JSON.stringify(existingWinners), game.game_id]
                    );
                    
                    await db.run(
                        'UPDATE cards SET is_winner = 1 WHERE card_id = ?',
                        winningCard.card.card_id
                    );
                    
                    // Award prize
                    const prizePerWinner = game.prize_amount / existingWinners.length;
                    await db.run(
                        'UPDATE users SET balance = balance + ?, total_wins = total_wins + 1 WHERE user_id = ?',
                        [prizePerWinner, user_id]
                    );
                    
                    // Record win transaction
                    await db.run(
                        'INSERT INTO transactions (user_id, amount, type, game_id, description) VALUES (?, ?, ?, ?, ?)',
                        [user_id, prizePerWinner, 'win', game.game_id, `Won with ${winningCard.win.type}`]
                    );
                    
                    // Create card HTML for display
                    const cardHtml = generateCardHtml(JSON.parse(winningCard.card.numbers));
                    
                    // Broadcast winner to all
                    io.emit('show_winner', {
                        winner_name: name,
                        card_number: winningCard.card.card_number,
                        card_html: cardHtml,
                        win_type: winningCard.win.type
                    });
                    
                    logger.info(`Winner declared: ${name} with card #${winningCard.card.card_number}`);
                }
            } else {
                socket.emit('error_message', 'No winning pattern found! False BINGO!');
            }
            
        } catch (error) {
            logger.error('Web App bingo claim error:', error);
            socket.emit('error_message', 'Error checking BINGO');
        }
    });

    socket.on('disconnect', () => {
        logger.info('📱 Web App disconnected:', socket.id);
    });
});

// ==================== HELPER FUNCTIONS ====================

async function registerUser(msg) {
    const userId = msg.from.id;
    const username = msg.from.username || `user_${userId}`;
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';

    try {
        const existing = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
        
        if (!existing) {
            await db.run(
                'INSERT INTO users (user_id, username, first_name, last_name, balance, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [userId, username, firstName, lastName, parseInt(process.env.DEFAULT_BALANCE || 1000), new Date().toISOString(), new Date().toISOString()]
            );
            logger.info(`New user registered: ${username} (${userId})`);
            return true;
        } else {
            // Update last active
            await db.run(
                'UPDATE users SET last_active = ?, username = ?, first_name = ?, last_name = ? WHERE user_id = ?',
                [new Date().toISOString(), username, firstName, lastName, userId]
            );
            return false;
        }
    } catch (error) {
        logger.error('Error registering user:', error);
        return false;
    }
}

async function generateCardNumber() {
    let number;
    let exists;
    const maxAttempts = 100;
    let attempts = 0;
    
    do {
        number = Math.floor(Math.random() * 900) + 100; // 100-999
        exists = await db.get('SELECT card_id FROM cards WHERE card_number = ?', number);
        attempts++;
        if (attempts > maxAttempts) {
            // If we can't find a unique number, use timestamp
            number = parseInt(Date.now().toString().slice(-6));
            break;
        }
    } while (exists);
    
    return number;
}

function generateBingoCard(cardNumber) {
    let nums = [];
    let seed = cardNumber || Math.floor(Math.random() * 1000);
    
    for (let col = 0; col < 5; col++) {
        let min = col * 15 + 1;
        let max = (col + 1) * 15;
        
        let colNumbers = [];
        while (colNumbers.length < 5) {
            let n = ((seed * (col + 1) + colNumbers.length * 7) % (max - min + 1)) + min;
            if (!colNumbers.includes(n)) {
                colNumbers.push(n);
            }
        }
        // Sort column numbers
        colNumbers.sort((a, b) => a - b);
        nums.push(...colNumbers);
    }
    
    nums[12] = "FREE";
    return nums;
}

function formatCard(numbers, calledNumbers = []) {
    let result = '```\n';
    result += '╔═══════════════════════╗\n';
    result += '║   B   I   N   G   O   ║\n';
    result += '╠═══════════════════════╣\n';
    
    // Card grid
    for (let row = 0; row < 5; row++) {
        result += '║';
        for (let col = 0; col < 5; col++) {
            let index = row * 5 + col;
            let num = numbers[index];
            
            if (num === 'FREE') {
                result += '  ★  ';
            } else if (calledNumbers.includes(num)) {
                result += `  ✓  `;
            } else {
                result += ` ${num.toString().padStart(2, ' ')}  `;
            }
        }
        result += '║\n';
    }
    
    result += '╚═══════════════════════╝\n';
    result += '```';
    return result;
}

function formatCardPreview(numbers) {
    let result = '```\n';
    result += '┌───────────────┐\n';
    result += '│ B  I  N  G  O │\n';
    result += '├───────────────┤\n';
    
    for (let row = 0; row < 5; row++) {
        result += '│';
        for (let col = 0; col < 5; col++) {
            let index = row * 5 + col;
            let num = numbers[index];
            if (num === 'FREE') {
                result += ' ★ ';
            } else {
                result += ` ${num.toString().padStart(2, ' ')} `;
            }
        }
        result += '│\n';
    }
    
    result += '└───────────────┘\n';
    result += '```';
    return result;
}

function generateCardHtml(numbers) {
    let html = '<div style="background: white; padding: 20px; border-radius: 20px; max-width: 300px; margin: 0 auto;">';
    html += '<div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; background: #ddd; padding: 5px; border-radius: 10px;">';
    
    numbers.forEach(num => {
        if (num === 'FREE') {
            html += '<div style="background: gold; color: black; padding: 15px; text-align: center; border-radius: 8px; font-weight: bold;">FREE</div>';
        } else {
            html += `<div style="background: #f0f0f0; color: black; padding: 15px; text-align: center; border-radius: 8px; font-weight: bold;">${num}</div>`;
        }
    });
    
    html += '</div></div>';
    return html;
}

function checkCardForWin(card, calledNumbers, gameType) {
    // Helper function to check if a line (row/col) is complete
    const isLineComplete = (indices) => {
        return indices.every(index => 
            card[index] === "FREE" || calledNumbers.includes(card[index])
        );
    };

    switch(gameType) {
        case 'full house':
            const allMarked = card.every((num, index) => 
                num === "FREE" || calledNumbers.includes(num)
            );
            if (allMarked) return { type: 'full house', cells: card.map((_, i) => i) };
            break;
            
        case '1 row':
            for (let row = 0; row < 5; row++) {
                let indices = [0,1,2,3,4].map(col => row * 5 + col);
                if (isLineComplete(indices)) {
                    return { type: 'row', cells: indices };
                }
            }
            break;
            
        case '1 column':
            for (let col = 0; col < 5; col++) {
                let indices = [0,1,2,3,4].map(row => row * 5 + col);
                if (isLineComplete(indices)) {
                    return { type: 'column', cells: indices };
                }
            }
            break;
            
        case '4 corners':
            let corners = [0, 4, 20, 24];
            if (isLineComplete(corners)) {
                return { type: 'corners', cells: corners };
            }
            break;
            
        case 'X shape':
            let xIndices = [0, 4, 6, 8, 12, 16, 18, 20, 24];
            if (isLineComplete(xIndices)) {
                return { type: 'X shape', cells: xIndices };
            }
            break;
            
        case 'random':
            return checkCardForWin(card, calledNumbers, 'full house') || 
                   checkCardForWin(card, calledNumbers, '1 row') || 
                   checkCardForWin(card, calledNumbers, '1 column') ||
                   checkCardForWin(card, calledNumbers, '4 corners') ||
                   checkCardForWin(card, calledNumbers, 'X shape');
    }
    return null;
}

async function checkWinners(gameId, lastNumber) {
    try {
        const game = await db.get('SELECT * FROM games WHERE game_id = ?', gameId);
        if (!game) return [];

        const cards = await db.all('SELECT * FROM cards WHERE game_id = ? AND is_winner = 0', gameId);
        const calledNumbers = JSON.parse(game.called_numbers);
        let winners = JSON.parse(game.winners);
        let newWinners = [];

        for (const card of cards) {
            const numbers = JSON.parse(card.numbers);
            const win = checkCardForWin(numbers, calledNumbers, game.game_type);
            
            if (win) {
                // Mark as winner
                await db.run('UPDATE cards SET is_winner = 1 WHERE card_id = ?', card.card_id);
                
                // Add to winners list
                newWinners.push({
                    card_number: card.card_number,
                    win_type: win.type,
                    winning_cells: win.cells,
                    called_number: lastNumber,
                    user_id: card.user_id
                });

                winners.push({
                    card_number: card.card_number,
                    win_type: win.type,
                    winning_cells: win.cells,
                    called_number: lastNumber
                });

                // Award prize to user
                const prizePerWinner = game.prize_amount / winners.length;
                
                // Update user balance and stats
                await db.run(
                    `UPDATE users SET 
                        balance = balance + ?, 
                        total_wins = total_wins + 1,
                        total_won = total_won + ?
                    WHERE user_id = ?`,
                    [prizePerWinner, prizePerWinner, card.user_id]
                );

                // Record win transaction
                await db.run(
                    `INSERT INTO transactions 
                        (user_id, amount, type, game_id, description) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [card.user_id, prizePerWinner, 'win', gameId, `Won with ${win.type}`]
                );

                // Get user info for notification
                const user = await db.get('SELECT username FROM users WHERE user_id = ?', card.user_id);
                
                // Create card HTML
                const cardHtml = generateCardHtml(numbers);
                
                // Notify via socket
                io.emit('show_winner', {
                    winner_name: user?.username || 'Player',
                    card_number: card.card_number,
                    card_html: cardHtml,
                    win_type: win.type
                });
                
                logger.info(`Winner found: Card #${card.card_number} with ${win.type}`);
            }
        }

        // Update game with winners
        if (newWinners.length > 0) {
            await db.run('UPDATE games SET winners = ? WHERE game_id = ?', 
                [JSON.stringify(winners), gameId]
            );
        }

        return newWinners;
    } catch (error) {
        logger.error('Error checking winners:', error);
        return [];
    }
}

async function updateGameStats(gameId) {
    try {
        const totalCards = await db.get('SELECT COUNT(*) as count FROM cards WHERE game_id = ?', gameId);
        const totalPlayers = await db.get('SELECT COUNT(DISTINCT user_id) as count FROM cards WHERE game_id = ?', gameId);
        
        await db.run(
            'UPDATE games SET total_players = ?, total_cards = ? WHERE game_id = ?',
            [totalPlayers.count, totalCards.count, gameId]
        );
        
        logger.info(`Game #${gameId} Stats - Players: ${totalPlayers.count}, Cards: ${totalCards.count}`);
    } catch (error) {
        logger.error('Error updating game stats:', error);
    }
}

function isAdmin(userId) {
    return adminIds.includes(userId);
}

// ==================== BOT COMMANDS ====================

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        await registerUser(msg);
        
        const webAppUrl = `${BASE_URL}/bingo-webapp`;
        
        const keyboard = {
            inline_keyboard: [[
                {
                    text: "🎮 በድህረ ገፅ ተጫወት",
                    web_app: { url: webAppUrl }
                }
            ]]
        };

        await bot.sendMessage(chatId, 
            `🎰 *MK BINGO DELUXE* 🎰\n\n` +
            `እንኳን ደህና መጡ! በታች ያለውን ቁልፍ ተጫን በማለት በድህረ ገፅ መጫወት ይችላሉ።\n\n` +
            `*ዋና ዋና ትዕዛዛት:*\n` +
            `💰 /balance - ባላንስ ለማየት\n` +
            `🎫 /buy - ካርድ ለመግዛት\n` +
            `🎮 /mycards - ካርዶቼን ለማየት\n` +
            `📊 /stats - ስታቲስቲክስ`,
            {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            }
        );
    } catch (error) {
        logger.error('Error in /start:', error);
        await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
    }
});

// Balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        const user = await db.get(
            'SELECT balance, total_wins, total_cards_bought FROM users WHERE user_id = ?', 
            userId
        );

        if (!user) {
            return bot.sendMessage(chatId, '❌ Please use /start first.');
        }

        await bot.sendMessage(chatId, 
            `💰 *Your Balance*\n\n` +
            `Current Balance: *${user.balance} ETB*\n` +
            `Total Wins: *${user.total_wins || 0}*\n` +
            `Cards Bought: *${user.total_cards_bought || 0}*`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        logger.error('Error in /balance:', error);
        await bot.sendMessage(chatId, '❌ An error occurred.');
    }
});

// API endpoint for game stats
app.get('/api/stats', async (req, res) => {
    try {
        const game = await db.get('SELECT * FROM games WHERE status = "active" ORDER BY game_id DESC LIMIT 1');
        
        if (!game) {
            return res.json({ active: false });
        }

        const players = await db.all(
            'SELECT u.username, COUNT(c.card_id) as card_count FROM users u JOIN cards c ON u.user_id = c.user_id WHERE c.game_id = ? GROUP BY u.user_id',
            game.game_id
        );

        const totalCards = await db.get('SELECT COUNT(*) as count FROM cards WHERE game_id = ?', game.game_id);

        const stats = {
            active: true,
            game_id: game.game_id,
            game_type: game.game_type,
            prize_amount: game.prize_amount,
            card_price: game.card_price,
            called_numbers: JSON.parse(game.called_numbers),
            called_count: JSON.parse(game.called_numbers).length,
            winners: JSON.parse(game.winners),
            players: players,
            total_players: players.length,
            total_cards: totalCards.count
        };

        res.json(stats);
    } catch (error) {
        logger.error('API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API endpoint for user stats
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        const user = await db.get(
            'SELECT user_id, username, balance, total_wins, total_cards_bought, total_spent, total_won, created_at, last_active FROM users WHERE user_id = ?',
            userId
        );
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const cards = await db.all(
            'SELECT COUNT(*) as total, SUM(CASE WHEN is_winner = 1 THEN 1 ELSE 0 END) as winners FROM cards WHERE user_id = ?',
            userId
        );

        const recentTransactions = await db.all(
            'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
            userId
        );

        res.json({
            ...user,
            cards: cards[0],
            recent_transactions: recentTransactions
        });
    } catch (error) {
        logger.error('API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== INITIALIZE ====================

async function main() {
    try {
        await initializeDatabase();
        
        // Check if there's an active game, if not create a waiting game
        const activeGame = await db.get('SELECT * FROM games WHERE status = "active"');
        if (!activeGame) {
            const waitingGame = await db.get('SELECT * FROM games WHERE status = "waiting"');
            if (!waitingGame) {
                await db.run(
                    `INSERT INTO games 
                        (game_type, prize_amount, card_price, status, started_at) 
                    VALUES (?, ?, ?, ?, ?)`,
                    ['full house', 
                     parseInt(process.env.DEFAULT_PRIZE || 2000), 
                     parseInt(process.env.DEFAULT_CARD_PRICE || 10), 
                     'waiting', 
                     new Date().toISOString()]
                );
                logger.info('Created default waiting game');
            }
        }
        
        // Set bot commands
        await bot.setMyCommands([
            { command: 'start', description: 'ጀምር / Start' },
            { command: 'balance', description: 'ባላንስ / Balance' },
            { command: 'mycards', description: 'ካርዶቼ / My Cards' },
            { command: 'stats', description: 'ስታቲስቲክስ / Statistics' }
        ]);
        
        logger.info('✅ Bot is running...');
        logger.info(`📱 Web App URL: ${BASE_URL}`);
        logger.info(`👑 Admin IDs: ${adminIds.join(', ')}`);
        
    } catch (error) {
        logger.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT. Shutting down gracefully...');
    await db?.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM. Shutting down gracefully...');
    await db?.close();
    process.exit(0);
});

// Start server
server.listen(PORT, () => {
    logger.info(`🌐 Web server running on port ${PORT}`);
    logger.info(`📱 Web App available at http://localhost:${PORT}`);
});

main().catch(console.error);