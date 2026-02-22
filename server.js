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

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');

[PUBLIC_DIR, DATA_DIR, UPLOADS_DIR, AVATAR_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

const db = new sqlite3.Database(path.join(DATA_DIR, 'chat_database.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT NOT NULL, r TEXT NOT NULL,
        c TEXT, type TEXT DEFAULT 'text', status INTEGER DEFAULT 0,
        time TEXT NOT NULL, caption TEXT, reaction TEXT DEFAULT NULL, reply_context TEXT DEFAULT NULL
    )`);
    db.run("ALTER TABLE messages ADD COLUMN reply_context TEXT DEFAULT NULL", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_msg_users ON messages(s, r)");
    
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, content TEXT,
        type TEXT DEFAULT 'text', caption TEXT DEFAULT '', bg_color TEXT DEFAULT '#FF3B30',
        viewers TEXT DEFAULT '[]', likes TEXT DEFAULT '[]', time TEXT NOT NULL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS story_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT, story_id INTEGER NOT NULL,
        username TEXT NOT NULL, message TEXT NOT NULL, time TEXT NOT NULL,
        FOREIGN KEY(story_id) REFERENCES stories(id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        description TEXT DEFAULT '', avatar TEXT DEFAULT '', created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, settings TEXT DEFAULT '{}', is_closed INTEGER DEFAULT 0
    )`);
    db.run("ALTER TABLE groups ADD COLUMN is_closed INTEGER DEFAULT 0", () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_group_id ON groups(group_id)");
    
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, username TEXT NOT NULL,
        role TEXT DEFAULT 'member', joined_at TEXT NOT NULL, muted INTEGER DEFAULT 0,
        UNIQUE(group_id, username)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, sender TEXT NOT NULL,
        content TEXT, type TEXT DEFAULT 'text', time TEXT NOT NULL, caption TEXT,
        reaction TEXT DEFAULT NULL, pinned INTEGER DEFAULT 0, reply_to INTEGER DEFAULT NULL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS friendships (
        id INTEGER PRIMARY KEY AUTOINCREMENT, requester TEXT NOT NULL, recipient TEXT NOT NULL,
        status TEXT DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(requester, recipient)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS chat_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, contact_id TEXT NOT NULL,
        is_archived INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, UNIQUE(username, contact_id)
    )`);
});

const getUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]'); } catch(e) { return []; } };
const saveUsers = (users) => { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch(e) {} };

const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8, pingInterval: 10000, pingTimeout: 5000 });
const onlineUsers = new Map();

const broadcastUserStatus = (username, isOnline, lastSeen = null) => {
    io.emit('user_status_change', { username: username.toLowerCase(), status: isOnline ? 'online' : 'offline', last_seen: lastSeen || new Date().toISOString() });
};

function insertGroupMsg(data) {
    const timestamp = new Date().toISOString();
    let content = data.content;
    if (data.type !== 'text' && data.type !== 'call' && content && content.startsWith('data:')) {
        content = saveBase64File(content, 'uploads', 'group_' + data.sender);
    }
    db.run(`INSERT INTO group_messages (group_id, sender, content, type, time, caption, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [data.group_id, data.sender, content, data.type || 'text', timestamp, data.caption || '', data.reply_to || null],
        function(err) {
            if (err) return;
            db.get(`SELECT * FROM group_messages WHERE id = ?`, [this.lastID], (e, row) => {
                if (row) {
                    db.all(`SELECT username FROM group_members WHERE group_id = ?`, [data.group_id], (err, members) => {
                        if (members) members.forEach(m => {
                            if (onlineUsers.has(m.username)) onlineUsers.get(m.username).forEach(sid => io.to(sid).emit('new_group_msg', row));
                        });
                    });
                }
            });
        }
    );
}

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        if (!username) return;
        const un = username.toLowerCase().trim();
        socket.username = un;
        if (!onlineUsers.has(un)) {
            onlineUsers.set(un, new Set());
            let users = getUsers(), uIdx = users.findIndex(u => u.username === un);
            if (uIdx !== -1) { users[uIdx].is_online = true; saveUsers(users); }
        }
        onlineUsers.get(un).add(socket.id);
        broadcastUserStatus(un, true);
    });

    socket.on('send_msg', (data) => {
        if (!data.s || !data.r || !data.c) return;
        const sender = data.s.toLowerCase().trim(), recipient = data.r.toLowerCase().trim();
        const timestamp = new Date().toISOString();
        const isRecipientOnline = onlineUsers.has(recipient) && onlineUsers.get(recipient).size > 0;
        const status = isRecipientOnline ? 1 : 0;
        let content = data.c;
        if (data.type !== 'text' && data.type !== 'call' && data.type !== 'story_reply' && content && content.startsWith('data:')) {
            content = saveBase64File(content, 'uploads', sender);
        }
        const replyContext = data.reply_context ? JSON.stringify(data.reply_context) : null;
        db.run("INSERT INTO messages (s, r, c, type, status, time, caption, reply_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [sender, recipient, content, data.type || 'text', status, timestamp, data.caption || '', replyContext],
            function(err) {
                if (err) return;
                db.get("SELECT * FROM messages WHERE id = ?", [this.lastID], (e, row) => {
                    if (row) {
                        if (onlineUsers.has(recipient)) onlineUsers.get(recipient).forEach(sid => io.to(sid).emit('new_msg', row));
                        if (onlineUsers.has(sender)) onlineUsers.get(sender).forEach(sid => io.to(sid).emit('new_msg', row));
                    }
                });
            }
        );
    });

    // WebRTC signaling (raw ICE/SDP without PeerJS)
    socket.on('call_offer', (data) => {
        if (onlineUsers.has(data.to.toLowerCase())) {
            onlineUsers.get(data.to.toLowerCase()).forEach(sid => io.to(sid).emit('call_offer', { from: data.from, offer: data.offer, type: data.type }));
        }
    });
    socket.on('call_answer', (data) => {
        if (onlineUsers.has(data.to.toLowerCase())) {
            onlineUsers.get(data.to.toLowerCase()).forEach(sid => io.to(sid).emit('call_answer', { from: data.from, answer: data.answer }));
        }
    });
    socket.on('call_ice', (data) => {
        if (onlineUsers.has(data.to.toLowerCase())) {
            onlineUsers.get(data.to.toLowerCase()).forEach(sid => io.to(sid).emit('call_ice', { from: data.from, candidate: data.candidate }));
        }
    });
    socket.on('reject_call', (data) => {
        if (onlineUsers.has(data.to.toLowerCase())) onlineUsers.get(data.to.toLowerCase()).forEach(sid => io.to(sid).emit('call_rejected'));
    });
    socket.on('end_call', (data) => {
        if (onlineUsers.has(data.to.toLowerCase())) onlineUsers.get(data.to.toLowerCase()).forEach(sid => io.to(sid).emit('call_ended'));
    });

    socket.on('delete_msg', (data) => {
        const { id, username } = data;
        db.get("SELECT * FROM messages WHERE id = ?", [id], (err, row) => {
            if (row && (row.s === username || row.r === username)) {
                db.run("DELETE FROM messages WHERE id = ?", [id], (err) => {
                    if (!err) {
                        if (onlineUsers.has(row.s)) onlineUsers.get(row.s).forEach(sid => io.to(sid).emit('msg_deleted', id));
                        if (onlineUsers.has(row.r)) onlineUsers.get(row.r).forEach(sid => io.to(sid).emit('msg_deleted', id));
                    }
                });
            }
        });
    });

    socket.on('react_msg', (data) => {
        const { id, reaction } = data;
        db.get("SELECT * FROM messages WHERE id = ?", [id], (err, row) => {
            if (row) {
                db.run("UPDATE messages SET reaction = ? WHERE id = ?", [reaction, id], (err) => {
                    if (!err) {
                        if (onlineUsers.has(row.s)) onlineUsers.get(row.s).forEach(sid => io.to(sid).emit('msg_reacted', { id, reaction }));
                        if (onlineUsers.has(row.r)) onlineUsers.get(row.r).forEach(sid => io.to(sid).emit('msg_reacted', { id, reaction }));
                    }
                });
            }
        });
    });

    socket.on('mark_read', (data) => {
        if (!data.s || !data.r) return;
        const sender = data.s.toLowerCase().trim(), reader = data.r.toLowerCase().trim();
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [sender, reader], function(err) {
            if (!err && this.changes > 0) {
                if (onlineUsers.has(sender)) onlineUsers.get(sender).forEach(sid => io.to(sid).emit('msgs_read_update', { reader, sender }));
                if (onlineUsers.has(reader)) onlineUsers.get(reader).forEach(sid => io.to(sid).emit('msgs_read_update', { reader, sender }));
            }
        });
    });

    socket.on('send_group_msg', (data) => {
        if (!data.group_id || !data.sender || !data.content) return;
        db.get(`SELECT is_closed FROM groups WHERE group_id = ?`, [data.group_id], (err, group) => {
            if (err || !group) return;
            if (group.is_closed) {
                db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [data.group_id, data.sender], (err, member) => {
                    if (member && member.role === 'admin') insertGroupMsg(data);
                    else if (onlineUsers.has(data.sender)) onlineUsers.get(data.sender).forEach(sid => io.to(sid).emit('group_closed_error', { group_id: data.group_id }));
                });
            } else insertGroupMsg(data);
        });
    });

    socket.on('delete_group_msg', (data) => {
        const { id, group_id, username } = data;
        db.get(`SELECT * FROM group_messages WHERE id = ?`, [id], (err, row) => {
            if (row && row.group_id === group_id) {
                db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], (err, member) => {
                    if (member && (row.sender === username || member.role === 'admin')) {
                        db.run(`DELETE FROM group_messages WHERE id = ?`, [id], (err) => {
                            if (!err) {
                                db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
                                    if (members) members.forEach(m => {
                                        if (onlineUsers.has(m.username)) onlineUsers.get(m.username).forEach(sid => io.to(sid).emit('group_msg_deleted', { id, group_id }));
                                    });
                                });
                            }
                        });
                    }
                });
            }
        });
    });

    socket.on('react_group_msg', (data) => {
        const { id, reaction, group_id } = data;
        db.run(`UPDATE group_messages SET reaction = ? WHERE id = ?`, [reaction, id], (err) => {
            if (!err) {
                db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
                    if (members) members.forEach(m => {
                        if (onlineUsers.has(m.username)) onlineUsers.get(m.username).forEach(sid => io.to(sid).emit('group_msg_reacted', { id, reaction, group_id }));
                    });
                });
            }
        });
    });

    socket.on('friend_accepted', (data) => {
        const { by, request_id } = data;
        if (request_id) {
            db.get(`SELECT requester FROM friendships WHERE id = ?`, [request_id], (err, row) => {
                if (row && onlineUsers.has(row.requester)) onlineUsers.get(row.requester).forEach(sid => io.to(sid).emit('friend_accepted', { by }));
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            const un = socket.username;
            if (onlineUsers.has(un)) {
                onlineUsers.get(un).delete(socket.id);
                if (onlineUsers.get(un).size === 0) {
                    onlineUsers.delete(un);
                    let users = getUsers(), uIdx = users.findIndex(u => u.username === un);
                    const lastSeen = new Date().toISOString();
                    if (uIdx !== -1) { users[uIdx].is_online = false; users[uIdx].last_seen = lastSeen; saveUsers(users); }
                    broadcastUserStatus(un, false, lastSeen);
                }
            }
        }
    });
});

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static('public'));

app.post('/register', async (req, res) => {
    const { username, password, display_name } = req.body;
    if (!username || !password) return res.status(400).json({error: "Campos obrigatórios"});
    let users = getUsers();
    const un = username.toLowerCase().trim();
    if (users.find(u => u.username === un)) return res.status(400).json({error: "Usuário já existe"});
    const hash = await bcrypt.hash(password, 10);
    users.push({ username: un, display_name: display_name || un, password: hash, bio: 'WhatsApp 2026 Premium', avatar: '', bg_image: '', last_seen: null, is_online: false });
    saveUsers(users);
    res.json({ok: true});
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({error: "Campos obrigatórios"});
    const user = getUsers().find(u => u.username === username.toLowerCase().trim());
    if (user && await bcrypt.compare(password, user.password)) {
        const { password: _, ...safe } = user; res.json(safe);
    } else res.status(401).json({error: "Credenciais inválidas"});
});

app.get('/chats/:me', (req, res) => {
    const me = req.params.me.toLowerCase().trim();
    db.all(`SELECT m.*, CASE WHEN s = ? THEN r ELSE s END as contact, cs.is_archived, cs.is_pinned
            FROM messages m LEFT JOIN chat_settings cs ON cs.username = ? AND cs.contact_id = CASE WHEN s = ? THEN r ELSE s END
            WHERE m.s = ? OR m.r = ? ORDER BY m.time DESC`, [me, me, me, me, me], (err, rows) => {
        if (err) return res.status(500).json([]);
        const chats = new Map(), users = getUsers();
        rows.forEach(r => {
            if (!chats.has(r.contact)) {
                const u = users.find(u => u.username === r.contact);
                let lastMsg = r.c;
                if (r.type === 'image') lastMsg = '📷 Foto';
                else if (r.type === 'video') lastMsg = '🎥 Vídeo';
                else if (r.type === 'audio') lastMsg = '🎤 Áudio';
                else if (r.type === 'story_reply') lastMsg = '💬 Respondeu ao status';
                chats.set(r.contact, { contact: r.contact, display_name: u?.display_name || r.contact, avatar: u?.avatar || '', is_online: u?.is_online || false, last_seen: u?.last_seen || null, last_msg: lastMsg, last_time: r.time, type: r.type, is_archived: r.is_archived || 0, is_pinned: r.is_pinned || 0, unread: 0 });
            }
            if (r.r === me && r.status < 2) chats.get(r.contact).unread++;
        });
        res.json(Array.from(chats.values()));
    });
});

app.post('/chats/settings', (req, res) => {
    const { username, contact_id, is_archived, is_pinned } = req.body;
    const un = username.toLowerCase().trim(), ci = contact_id.toLowerCase().trim();
    db.run(`INSERT INTO chat_settings (username, contact_id, is_archived, is_pinned) VALUES (?, ?, ?, ?)
            ON CONFLICT(username, contact_id) DO UPDATE SET is_archived = CASE WHEN ? IS NOT NULL THEN ? ELSE is_archived END, is_pinned = CASE WHEN ? IS NOT NULL THEN ? ELSE is_pinned END`,
        [un, ci, is_archived !== undefined ? is_archived : 0, is_pinned !== undefined ? is_pinned : 0, is_archived, is_archived, is_pinned, is_pinned],
        function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/chats/delete', (req, res) => {
    const { username, contact_id } = req.body;
    db.run(`DELETE FROM messages WHERE (s = ? AND r = ?) OR (s = ? AND r = ?)`,
        [username.toLowerCase().trim(), contact_id.toLowerCase().trim(), contact_id.toLowerCase().trim(), username.toLowerCase().trim()],
        function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC",
        [req.params.u1.toLowerCase(), req.params.u2.toLowerCase(), req.params.u2.toLowerCase(), req.params.u1.toLowerCase()],
        (e, r) => res.json(r || []));
});

app.get('/user/:u', (req, res) => {
    const user = getUsers().find(u => u.username === req.params.u.toLowerCase().trim());
    if (user) { const { password, ...safe } = user; res.json(safe); }
    else res.status(404).json({error: "Não encontrado"});
});

app.post('/update-profile', (req, res) => {
    const { username, bio, avatar, bg_image, display_name } = req.body;
    let users = getUsers(), idx = users.findIndex(u => u.username === username.toLowerCase().trim());
    if (idx !== -1) {
        if (bio !== undefined) users[idx].bio = bio;
        if (display_name !== undefined) users[idx].display_name = display_name;
        if (avatar && avatar.startsWith('data:')) users[idx].avatar = saveBase64File(avatar, 'avatars', username);
        if (bg_image && bg_image.startsWith('data:')) users[idx].bg_image = saveBase64File(bg_image, 'uploads', 'bg_'+username);
        saveUsers(users);
        res.json({ok: true, user: users[idx]});
    } else res.status(404).send();
});

app.get('/stories', (req, res) => {
    const { viewer } = req.query;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.all("SELECT * FROM stories WHERE time > ? ORDER BY time DESC", [yesterday], (err, rows) => {
        if (err) return res.status(500).json([]);
        const users = getUsers();
        const mapStory = (s) => {
            const u = users.find(u => u.username === s.username);
            let viewers = [], likes = [];
            try { viewers = JSON.parse(s.viewers || '[]'); } catch(e) {}
            try { likes = JSON.parse(s.likes || '[]'); } catch(e) {}
            return { ...s, display_name: u?.display_name || s.username, avatar: u?.avatar || '', viewers, likes };
        };
        const processAndGroup = (stories) => {
            const grouped = {};
            stories.forEach(s => {
                if (!grouped[s.username]) grouped[s.username] = { username: s.username, display_name: s.display_name, avatar: s.avatar, stories: [] };
                grouped[s.username].stories.push(s);
            });
            return Object.values(grouped);
        };
        if (viewer) {
            const vl = viewer.toLowerCase().trim();
            db.all(`SELECT * FROM friendships WHERE (requester = ? OR recipient = ?) AND status = 'accepted'`, [vl, vl], (err, friendships) => {
                const friendUsernames = (friendships || []).map(f => f.requester === vl ? f.recipient : f.requester);
                friendUsernames.push(vl);
                res.json(processAndGroup(rows.filter(s => friendUsernames.includes(s.username)).map(mapStory)));
            });
        } else {
            res.json(processAndGroup(rows.map(mapStory)));
        }
    });
});

app.post('/stories', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    if (!username) return res.status(400).json({ error: 'Username obrigatório' });
    let finalContent = content;
    if (type !== 'text' && content && content.startsWith('data:')) {
        if (type === 'video') {
            const b64 = content.split(';base64,')[1] || '';
            const sizeBytes = (b64.length * 3) / 4;
            if (sizeBytes > 100 * 1024 * 1024) return res.status(413).json({ error: 'Vídeo muito grande. Máximo 100MB.' });
        }
        finalContent = saveBase64File(content, 'uploads', 'story_' + username);
        if (!finalContent) return res.status(500).json({ error: 'Erro ao salvar arquivo' });
    }
    const time = new Date().toISOString();
    db.run("INSERT INTO stories (username, content, type, caption, bg_color, time) VALUES (?, ?, ?, ?, ?, ?)",
        [username, finalContent || '', type || 'text', caption || '', bg_color || '#FF3B30', time],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('new_story', { id: this.lastID, username, content: finalContent, type: type || 'text', caption: caption || '', bg_color: bg_color || '#FF3B30', time });
            res.json({ ok: true });
        });
});

app.post('/stories/:id/view', (req, res) => {
    const { id } = req.params, { username } = req.body;
    db.get('SELECT viewers FROM stories WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Story não encontrado' });
        let viewers = []; try { viewers = JSON.parse(row.viewers || '[]'); } catch(e) {}
        if (!viewers.includes(username)) {
            viewers.push(username);
            db.run('UPDATE stories SET viewers = ? WHERE id = ?', [JSON.stringify(viewers), id], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ ok: true });
            });
        } else res.json({ ok: true });
    });
});

app.post('/stories/:id/like', (req, res) => {
    const { id } = req.params, { username } = req.body;
    db.get('SELECT likes, username as story_owner FROM stories WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Story não encontrado' });
        let likes = []; try { likes = JSON.parse(row.likes || '[]'); } catch(e) {}
        const index = likes.indexOf(username);
        if (index === -1) likes.push(username); else likes.splice(index, 1);
        db.run('UPDATE stories SET likes = ? WHERE id = ?', [JSON.stringify(likes), id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (onlineUsers.has(row.story_owner)) onlineUsers.get(row.story_owner).forEach(sid => io.to(sid).emit('story_liked', { story_id: id, username, liked: index === -1 }));
            res.json({ ok: true, liked: index === -1 });
        });
    });
});

app.post('/stories/:id/reply', (req, res) => {
    const { id } = req.params, { username, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });
    const time = new Date().toISOString();
    db.run('INSERT INTO story_replies (story_id, username, message, time) VALUES (?, ?, ?, ?)',
        [id, username, message, time], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            db.get('SELECT username FROM stories WHERE id = ?', [id], (err, story) => {
                if (story && onlineUsers.has(story.username)) onlineUsers.get(story.username).forEach(sid => io.to(sid).emit('story_reply', { story_id: id, from: username, message, time }));
            });
            res.json({ ok: true, id: this.lastID });
        });
});

app.get('/stories/:id/viewers', (req, res) => {
    db.get('SELECT viewers FROM stories WHERE id = ?', [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Story não encontrado' });
        let viewers = []; try { viewers = JSON.parse(row.viewers || '[]'); } catch(e) {}
        const users = getUsers();
        res.json(viewers.map(v => { const u = users.find(u => u.username === v); return { username: v, display_name: u?.display_name || v, avatar: u?.avatar || '' }; }));
    });
});

app.post('/groups/create', (req, res) => {
    const { name, description, created_by, members } = req.body;
    if (!name || !created_by) return res.status(400).json({ error: 'Nome e criador obrigatórios' });
    const groupId = 'g_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString();
    db.run(`INSERT INTO groups (group_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        [groupId, name, description || '', created_by, createdAt], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`INSERT INTO group_members (group_id, username, role, joined_at) VALUES (?, ?, 'admin', ?)`, [groupId, created_by, createdAt]);
            if (members && Array.isArray(members)) {
                members.forEach(u => { if (u !== created_by) db.run(`INSERT INTO group_members (group_id, username, role, joined_at) VALUES (?, ?, 'member', ?)`, [groupId, u, createdAt]); });
            }
            io.emit('new_group', { group_id: groupId, name, created_by });
            res.json({ ok: true, group_id: groupId });
        });
});

app.get('/groups/my/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    db.all(`SELECT g.*, gm.role, gm.muted FROM groups g INNER JOIN group_members gm ON g.group_id = gm.group_id WHERE gm.username = ? ORDER BY g.created_at DESC`, [username], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows || []);
    });
});

app.get('/groups/:group_id', (req, res) => {
    db.get(`SELECT * FROM groups WHERE group_id = ?`, [req.params.group_id], (err, group) => {
        if (err || !group) return res.status(404).json({ error: 'Grupo não encontrado' });
        db.all(`SELECT username, role, joined_at, muted FROM group_members WHERE group_id = ?`, [req.params.group_id], (err, members) => {
            if (err) return res.status(500).json({ error: err.message });
            const users = getUsers();
            const membersWithData = (members || []).map(m => { const u = users.find(u => u.username === m.username); return { ...m, display_name: u?.display_name || m.username, avatar: u?.avatar || '', is_online: u?.is_online || false }; });
            res.json({ ...group, members: membersWithData });
        });
    });
});

app.post('/groups/:group_id/members/add', (req, res) => {
    const { group_id } = req.params, { username, added_by } = req.body;
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, added_by], (err, member) => {
        if (err || !member || member.role !== 'admin') return res.status(403).json({ error: 'Apenas admins podem adicionar membros' });
        const joinedAt = new Date().toISOString();
        db.run(`INSERT INTO group_members (group_id, username, role, joined_at) VALUES (?, ?, 'member', ?)`, [group_id, username, joinedAt], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('group_member_added', { group_id, username }); res.json({ ok: true });
        });
    });
});

app.post('/groups/:group_id/members/remove', (req, res) => {
    const { group_id } = req.params, { username, removed_by } = req.body;
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, removed_by], (err, member) => {
        if (err || !member || member.role !== 'admin') return res.status(403).json({ error: 'Apenas admins podem remover membros' });
        db.run(`DELETE FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('group_member_removed', { group_id, username }); res.json({ ok: true });
        });
    });
});

app.post('/groups/:group_id/leave', (req, res) => {
    const { group_id } = req.params, { username } = req.body;
    db.run(`DELETE FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('group_member_left', { group_id, username }); res.json({ ok: true });
    });
});

app.post('/groups/:group_id/promote', (req, res) => {
    const { group_id } = req.params, { username, promoted_by } = req.body;
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, promoted_by], (err, member) => {
        if (err || !member || member.role !== 'admin') return res.status(403).json({ error: 'Apenas admins podem promover membros' });
        db.run(`UPDATE group_members SET role = 'admin' WHERE group_id = ? AND username = ?`, [group_id, username], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('member_promoted', { group_id, username }); res.json({ ok: true });
        });
    });
});

app.post('/groups/:group_id/toggle-close', (req, res) => {
    const { group_id } = req.params, { username } = req.body;
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], (err, member) => {
        if (err || !member || member.role !== 'admin') return res.status(403).json({ error: 'Apenas admins podem fechar o grupo' });
        db.get(`SELECT is_closed FROM groups WHERE group_id = ?`, [group_id], (err, group) => {
            if (err || !group) return res.status(404).json({ error: 'Grupo não encontrado' });
            const newState = group.is_closed ? 0 : 1;
            db.run(`UPDATE groups SET is_closed = ? WHERE group_id = ?`, [newState, group_id], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
                    if (members) members.forEach(m => { if (onlineUsers.has(m.username)) onlineUsers.get(m.username).forEach(sid => io.to(sid).emit('group_status_changed', { group_id, is_closed: newState })); });
                });
                res.json({ ok: true, is_closed: newState });
            });
        });
    });
});

app.get('/groups/:group_id/messages', (req, res) => {
    db.all(`SELECT * FROM group_messages WHERE group_id = ? ORDER BY time ASC`, [req.params.group_id], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows || []);
    });
});

app.post('/groups/:group_id/update', (req, res) => {
    const { group_id } = req.params, { name, description, avatar, updated_by } = req.body;
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, updated_by], (err, member) => {
        if (err || !member || member.role !== 'admin') return res.status(403).json({ error: 'Apenas admins podem atualizar o grupo' });
        let updates = [], values = [];
        if (name) { updates.push('name = ?'); values.push(name); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (avatar && avatar.startsWith('data:')) { const saved = saveBase64File(avatar, 'avatars', 'group_' + group_id); updates.push('avatar = ?'); values.push(saved); }
        if (updates.length === 0) return res.status(400).json({ error: 'Nenhuma atualização fornecida' });
        values.push(group_id);
        db.run(`UPDATE groups SET ${updates.join(', ')} WHERE group_id = ?`, values, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('group_updated', { group_id }); res.json({ ok: true });
        });
    });
});

app.post('/friends/request', (req, res) => {
    const { requester, recipient } = req.body;
    if (!requester || !recipient) return res.status(400).json({ error: 'Campos obrigatórios' });
    const req_l = requester.toLowerCase().trim(), rec_l = recipient.toLowerCase().trim();
    if (req_l === rec_l) return res.status(400).json({ error: 'Não pode adicionar a si mesmo' });
    db.get(`SELECT * FROM friendships WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)`, [req_l, rec_l, rec_l, req_l], (err, existing) => {
        if (existing) {
            if (existing.status === 'accepted') return res.status(400).json({ error: 'Já são amigos' });
            if (existing.status === 'pending') return res.status(400).json({ error: 'Solicitação já enviada' });
        }
        const now = new Date().toISOString();
        db.run(`INSERT INTO friendships (requester, recipient, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`, [req_l, rec_l, now, now], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (onlineUsers.has(rec_l)) onlineUsers.get(rec_l).forEach(sid => io.to(sid).emit('friend_request', { from: req_l, id: this.lastID }));
            res.json({ ok: true, id: this.lastID });
        });
    });
});

app.post('/friends/accept', (req, res) => {
    const { request_id, username } = req.body;
    if (!request_id || !username) return res.status(400).json({ error: 'Campos obrigatórios' });
    const user_l = username.toLowerCase().trim(), now = new Date().toISOString();
    db.get(`SELECT * FROM friendships WHERE id = ? AND recipient = ?`, [request_id, user_l], (err, request) => {
        if (err || !request) return res.status(404).json({ error: 'Solicitação não encontrada' });
        db.run(`UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?`, [now, request_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (onlineUsers.has(request.requester)) onlineUsers.get(request.requester).forEach(sid => io.to(sid).emit('friend_accepted', { by: user_l }));
            res.json({ ok: true });
        });
    });
});

app.post('/friends/reject', (req, res) => {
    const { request_id, username } = req.body;
    db.get(`SELECT * FROM friendships WHERE id = ? AND recipient = ?`, [request_id, username.toLowerCase().trim()], (err, request) => {
        if (err || !request) return res.status(404).json({ error: 'Solicitação não encontrada' });
        db.run(`DELETE FROM friendships WHERE id = ?`, [request_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
    });
});

app.post('/friends/remove', (req, res) => {
    const { username, friend } = req.body;
    const u_l = username.toLowerCase().trim(), f_l = friend.toLowerCase().trim();
    db.run(`DELETE FROM friendships WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)`, [u_l, f_l, f_l, u_l], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        if (onlineUsers.has(f_l)) onlineUsers.get(f_l).forEach(sid => io.to(sid).emit('friend_removed', { by: u_l }));
        res.json({ ok: true });
    });
});

app.get('/friends/requests/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    db.all(`SELECT * FROM friendships WHERE recipient = ? AND status = 'pending'`, [username], (err, rows) => {
        if (err) return res.status(500).json([]);
        const users = getUsers();
        res.json((rows || []).map(r => { const u = users.find(u => u.username === r.requester); return { id: r.id, username: r.requester, display_name: u?.display_name || r.requester, avatar: u?.avatar || '', created_at: r.created_at }; }));
    });
});

app.get('/friends/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    db.all(`SELECT * FROM friendships WHERE (requester = ? OR recipient = ?) AND status = 'accepted'`, [username, username], (err, rows) => {
        if (err) return res.status(500).json([]);
        const users = getUsers();
        res.json((rows || []).map(f => { const fn = f.requester === username ? f.recipient : f.requester; const u = users.find(u => u.username === fn); return { username: fn, display_name: u?.display_name || fn, avatar: u?.avatar || '', is_online: u?.is_online || false, last_seen: u?.last_seen || null }; }));
    });
});

app.get('/friends/check/:user1/:user2', (req, res) => {
    db.get(`SELECT * FROM friendships WHERE ((requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)) AND status = 'accepted'`,
        [req.params.user1.toLowerCase(), req.params.user2.toLowerCase(), req.params.user2.toLowerCase(), req.params.user1.toLowerCase()],
        (err, row) => res.json({ areFriends: !!row }));
});

function saveBase64File(base64Data, subDir, prefix) {
    if (!base64Data || typeof base64Data !== 'string' || !base64Data.includes(';base64,')) return '';
    try {
        const parts = base64Data.split(';base64,');
        if (parts.length !== 2) return '';
        const meta = parts[0], data = parts[1];
        let ext = 'png';
        const mimeMatch = meta.match(/data:(.+)/);
        if (mimeMatch && mimeMatch[1]) {
            const mime = mimeMatch[1];
            if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
            else if (mime.includes('gif')) ext = 'gif';
            else if (mime.includes('webp')) ext = 'webp';
            else if (mime.includes('mp4')) ext = 'mp4';
            else if (mime.includes('audio/ogg')) ext = 'ogg';
            else if (mime.includes('audio/wav')) ext = 'wav';
            else if (mime.includes('audio/webm')) ext = 'webm';
            else if (mime.includes('audio/mpeg')) ext = 'mp3';
            else if (mime.includes('webm')) ext = 'webm';
            else ext = mime.split('/')[1] || 'png';
        }
        const uniqueId = Math.random().toString(36).substring(2, 15);
        const filename = `${prefix}_${Date.now()}_${uniqueId}.${ext}`;
        const dirPath = path.join(PUBLIC_DIR, subDir);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        fs.writeFileSync(path.join(dirPath, filename), Buffer.from(data, 'base64'));
        return `/${subDir}/${filename}`;
    } catch (e) { console.error('Save File Error:', e); return ''; }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));
