const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// --- CONFIGURAÇÃO DE ARQUIVOS E PASTAS ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');

[PUBLIC_DIR, DATA_DIR, UPLOADS_DIR, AVATAR_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// --- FUNÇÕES AUXILIARES ---
const getUsers = () => {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]'); }
    catch (e) { return []; }
};
const saveUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const saveBase64File = (base64Data, subDir, prefix) => {
    if (!base64Data || !base64Data.includes(';base64,')) return '';
    try {
        const [meta, data] = base64Data.split(';base64,');
        const ext = meta.split('/')[1].split(';')[0];
        const filename = `${prefix}_${Date.now()}.${ext}`;
        const filepath = path.join(PUBLIC_DIR, subDir, filename);
        fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
        return `/${subDir}/${filename}`;
    } catch (e) { return ''; }
};

const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); 

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./chat_database.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time TEXT, caption TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, type TEXT, caption TEXT, bg_color TEXT, viewers TEXT DEFAULT '[]', time TEXT)");
});

const onlineUsers = {}; 

io.on('connection', (socket) => {
    socket.on('join', (username) => { 
        const un = username.toLowerCase();
        socket.username = un; 
        onlineUsers[un] = socket.id;
        let users = getUsers();
        let user = users.find(u => u.username === un);
        if (user) { user.is_online = true; saveUsers(users); }
        io.emit('user_status_change', { username: un, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        const recipientSocketId = onlineUsers[data.r.toLowerCase()];
        const status = recipientSocketId ? 1 : 0; 
        const timestamp = new Date().toISOString();
        
        let content = data.c;
        if (data.type !== 'text' && data.c.startsWith('data:')) {
            content = saveBase64File(data.c, 'uploads', data.s);
        }

        db.run("INSERT INTO messages (s, r, c, type, status, time, caption) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [data.s, data.r, content, data.type, status, timestamp, data.caption || ''], 
            function(err) {
                if(!err) {
                    db.get("SELECT * FROM messages WHERE id = ?", [this.lastID], (e, row) => {
                        if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', row);
                        socket.emit('msg_sent_ok', row);
                    });
                }
            }
        );
    });

    socket.on('mark_read', (data) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], function(err) {
            if(!err && this.changes > 0 && onlineUsers[data.s.toLowerCase()]) {
                io.to(onlineUsers[data.s.toLowerCase()]).emit('msgs_read_update', { reader: data.r });
            }
        });
    });

    socket.on('view_status', (data) => {
        db.get("SELECT viewers FROM stories WHERE id = ?", [data.story_id], (err, row) => {
            if(row) {
                let viewers = JSON.parse(row.viewers || '[]');
                if(!viewers.includes(data.viewer)) {
                    viewers.push(data.viewer);
                    db.run("UPDATE stories SET viewers = ? WHERE id = ?", [JSON.stringify(viewers), data.story_id], () => {
                        if(onlineUsers[data.owner.toLowerCase()]) {
                            io.to(onlineUsers[data.owner.toLowerCase()]).emit('status_viewed_update', { story_id: data.story_id, viewers });
                        }
                    });
                }
            }
        });
    });

    // WebRTC Signaling
    socket.on('call_user', (d) => { if(onlineUsers[d.to.toLowerCase()]) io.to(onlineUsers[d.to.toLowerCase()]).emit('call_incoming', d); });
    socket.on('answer_call', (d) => { if(onlineUsers[d.to.toLowerCase()]) io.to(onlineUsers[d.to.toLowerCase()]).emit('call_answered', d); });
    socket.on('ice_candidate', (d) => { if(onlineUsers[d.to.toLowerCase()]) io.to(onlineUsers[d.to.toLowerCase()]).emit('ice_candidate', d); });
    socket.on('end_call', (d) => { if(onlineUsers[d.to.toLowerCase()]) io.to(onlineUsers[d.to.toLowerCase()]).emit('call_ended', d); });

    socket.on('disconnect', () => { 
        if(socket.username) {
            delete onlineUsers[socket.username];
            let users = getUsers();
            let user = users.find(u => u.username === socket.username);
            if (user) { user.is_online = false; user.last_seen = new Date().toISOString(); saveUsers(users); }
            io.emit('user_status_change', { username: socket.username, status: 'offline', last_seen: new Date().toISOString() });
        }
    });
});

app.post('/register', async (req, res) => {
    const { username, password, display_name } = req.body;
    let users = getUsers();
    const un = username.toLowerCase().trim();
    if(users.find(u => u.username === un)) return res.status(400).json({error: "Usuário já existe"});
    const hash = await bcrypt.hash(password, 10);
    const newUser = { username: un, display_name: display_name || un, password: hash, bio: 'Telegram 2026', avatar: '', bg_image: '', last_seen: null };
    users.push(newUser);
    saveUsers(users);
    res.json({ok: true});
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = getUsers().find(u => u.username === username.toLowerCase().trim());
    if(user && await bcrypt.compare(password, user.password)) {
        const { password, ...safe } = user; res.json(safe);
    } else res.status(401).json({error: "Erro"});
});

app.get('/user/:u', (req, res) => {
    const user = getUsers().find(u => u.username === req.params.u.toLowerCase());
    if(user) { const { password, ...safe } = user; res.json(safe); }
    else res.json({ username: req.params.u, display_name: req.params.u });
});

app.post('/update-profile', (req, res) => {
    const { username, bio, avatar, bg_image, display_name } = req.body;
    let users = getUsers();
    let idx = users.findIndex(u => u.username === username.toLowerCase());
    if(idx !== -1) {
        if(bio !== undefined) users[idx].bio = bio;
        if(display_name !== undefined) users[idx].display_name = display_name;
        if(avatar && avatar.startsWith('data:')) users[idx].avatar = saveBase64File(avatar, 'avatars', username);
        if(bg_image && bg_image.startsWith('data:')) users[idx].bg_image = saveBase64File(bg_image, 'uploads', 'bg_'+username);
        saveUsers(users);
        res.json({ok: true, user: users[idx]});
    } else res.status(404).send();
});

app.post('/post-status', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    let fileUrl = content;
    if (type !== 'text' && content.startsWith('data:')) fileUrl = saveBase64File(content, 'uploads', 'status_'+username);
    db.run("INSERT INTO stories (username, content, type, caption, bg_color, time) VALUES (?, ?, ?, ?, ?, ?)", 
        [username, fileUrl, type, caption || '', bg_color || '', new Date().toISOString()], 
        () => res.json({ok: true})
    );
});

app.get('/get-status', (req, res) => {
    const limit = new Date(Date.now() - 86400000).toISOString();
    db.all("SELECT * FROM stories WHERE time > ? ORDER BY time ASC", [limit], (e, rows) => {
        const users = getUsers();
        res.json(rows.map(r => {
            const u = users.find(user => user.username === r.username);
            return { ...r, avatar: u?.avatar, display_name: u?.display_name || r.username, viewers: JSON.parse(r.viewers || '[]') };
        }));
    });
});

app.get('/chats/:me', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? OR r=?) ORDER BY time DESC", [req.params.me, req.params.me], (e, rows) => {
        const chats = {};
        rows.forEach(r => {
            const c = r.s === req.params.me ? r.r : r.s;
            if(!chats[c]) chats[c] = { contact: c, last_msg: r.c, last_time: r.time, unread: 0, type: r.type };
            if(r.r === req.params.me && r.s === c && r.status < 2) chats[c].unread++;
        });
        const users = getUsers();
        res.json(Object.values(chats).map(chat => {
            const u = users.find(u => u.username === chat.contact);
            return { ...chat, display_name: u?.display_name || chat.contact, avatar: u?.avatar, is_online: u?.is_online };
        }));
    });
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (e, r) => res.json(r || []));
});

server.listen(3001, () => console.log('3001'));