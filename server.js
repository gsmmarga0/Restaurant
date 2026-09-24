const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 4000;

// Your local print agent's address (Linux Mint machine)
// If the agent is on the same machine as this server, use http://localhost:3005
// If it's on another machine on the LAN, use its IP: http://192.168.1.100:3005
const PRINT_AGENT_URL = 'http://localhost:3005'; // <-- UPDATE THIS

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database Setup ---
const db = new sqlite3.Database('./restaurant.db');

db.serialize(() => {
    // Menu Items Catalogue
    db.run(`CREATE TABLE IF NOT EXISTS menu_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        description TEXT
    )`);

    // Orders
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_no TEXT NOT NULL,
        items TEXT NOT NULL, -- JSON string of items
        total REAL NOT NULL,
        status TEXT DEFAULT 'pending', -- pending, preparing, served
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Cashbook / UPI / Expenses
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, -- 'cash_in', 'upi_in', 'expense'
        amount REAL NOT NULL,
        description TEXT,
        order_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Inventory
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT,
        low_stock_threshold REAL,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tips
    db.run(`CREATE TABLE IF NOT EXISTS tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        amount REAL NOT NULL,
        staff_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- API ENDPOINTS ---

// Get all menu items
app.get('/api/menu', (req, res) => {
    db.all('SELECT * FROM menu_items ORDER BY category, name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a menu item
app.post('/api/menu', (req, res) => {
    const { name, category, price, description } = req.body;
    db.run('INSERT INTO menu_items (name, category, price, description) VALUES (?, ?, ?, ?)',
        [name, category, price, description],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, name, category, price, description });
        });
});

// Create a new order and trigger KOT print
app.post('/api/orders', async (req, res) => {
    const { table_no, items } = req.body; // items = [{ id, name, qty, price }]
    const total = items.reduce((sum, item) => sum + (item.price * item.qty), 0);

    const itemsJson = JSON.stringify(items);

    db.run('INSERT INTO orders (table_no, items, total) VALUES (?, ?, ?)',
        [table_no, itemsJson, total],
        async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const orderId = this.lastID;

            // --- Generate KOT Text ---
            let kotText = `Table: ${table_no}\nOrder #: ${orderId}\n\n`;
            items.forEach(item => {
                kotText += `${item.qty} x ${item.name}\n`;
                if (item.notes) kotText += `   Note: ${item.notes}\n`;
            });
            kotText += `\nTotal Items: ${items.length}`;

            // --- Send to Print Agent ---
            try {
                await axios.post(`${PRINT_AGENT_URL}/print-kot`, kotText, {
                    headers: { 'Content-Type': 'text/plain' }
                });
                console.log(`KOT sent to printer for order #${orderId}`);
            } catch (printError) {
                console.error('Failed to send KOT to printer:', printError.message);
                // Optionally, you can still return a success for the order, but flag the print failure.
            }

            res.json({ id: orderId, table_no, items, total, status: 'pending' });
        });
});

// Get recent orders
app.get('/api/orders', (req, res) => {
    db.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Update order status
app.put('/api/orders/:id/status', (req, res) => {
    const { status } = req.body;
    db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ updated: this.changes });
    });
});

// Add a transaction (cash/upi/expense)
app.post('/api/transactions', (req, res) => {
    const { type, amount, description, order_id } = req.body;
    db.run('INSERT INTO transactions (type, amount, description, order_id) VALUES (?, ?, ?, ?)',
        [type, amount, description, order_id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

// Get daily summary
app.get('/api/summary/today', (req, res) => {
    const query = `
        SELECT
            (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'cash_in' AND date(created_at) = date('now')) as cash_total,
            (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'upi_in' AND date(created_at) = date('now')) as upi_total,
            (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'expense' AND date(created_at) = date('now')) as expense_total,
            (SELECT COALESCE(SUM(amount), 0) FROM tips WHERE date(created_at) = date('now')) as tips_total,
            (SELECT COALESCE(SUM(total), 0) FROM orders WHERE date(created_at) = date('now')) as total_sales
    `;
    db.get(query, [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// Inventory
app.get('/api/inventory', (req, res) => {
    db.all('SELECT * FROM inventory ORDER BY item_name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/inventory', (req, res) => {
    const { item_name, quantity, unit, low_stock_threshold } = req.body;
    db.run('INSERT INTO inventory (item_name, quantity, unit, low_stock_threshold) VALUES (?, ?, ?, ?)',
        [item_name, quantity, unit, low_stock_threshold],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

// Tips
app.post('/api/tips', (req, res) => {
    const { order_id, amount, staff_name } = req.body;
    db.run('INSERT INTO tips (order_id, amount, staff_name) VALUES (?, ?, ?)',
        [order_id, amount, staff_name],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`GSM Restaurant Server running on http://localhost:${PORT}`);
});
