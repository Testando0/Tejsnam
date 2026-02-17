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

// --- CONFIGURAÇÃO DE DIRETÓRIOS ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');

// Garantir que pastas existam antes de qualquer operação
[PUBLIC_DIR, DATA_DIR, UPLOADS_DIR, AVATAR_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// --- DATABASE CORE ---
const db = new sqlite3.Database(path.join(DATA_DIR, 'chat_database.db'), (err) => {
    if (err) console.error('DB Connection Error:', err);
});

db.serialize(() => {
    // Tabelas com índices para performance e integridade
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        s TEXT NOT NULL, 
        r TEXT NOT NULL, 
        c TEXT, 
        type TEXT DEFAULT 'text', 
        status INTEGER DEFAULT 0, 
        time TEXT NOT NULL, 
        caption TEXT,
        reaction TEXT DEFAULT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_msg_users ON messages(s, r)");
    
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT NOT NULL, 
        content TEXT, 
        type TEXT DEFAULT 'text', 
        caption TEXT DEFAULT '', 
        bg_color TEXT DEFAULT '#FF3B30', 
        viewers TEXT DEFAULT '[]', 
        likes TEXT DEFAULT '[]',
        time TEXT NOT NULL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS story_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        message TEXT NOT NULL,
        time TEXT NOT NULL,
        FOREIGN KEY(story_id) REFERENCES stories(id)
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_story_replies ON story_replies(story_id)");
    
    // Tabelas de grupos
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settings TEXT DEFAULT '{}'
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_group_id ON groups(group_id)");
    
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TEXT NOT NULL,
        muted INTEGER DEFAULT 0,
        UNIQUE(group_id, username)
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(group_id, username)");
    
    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT,
        type TEXT DEFAULT 'text',
        time TEXT NOT NULL,
        caption TEXT,
        reaction TEXT DEFAULT NULL,
        pinned INTEGER DEFAULT 0,
        reply_to INTEGER DEFAULT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, time)");
    
    // Tabela de amizades
    db.run(`CREATE TABLE IF NOT EXISTS friendships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requester TEXT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(requester, recipient)
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_friendships ON friendships(requester, recipient, status)");
});

// --- USER MANAGEMENT CORE ---
const getUsers = () => {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data || '[]');
    } catch (e) {
        return [];
    }
};

const saveUsers = (users) => {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('Save Users Error:', e);
    }
};

// --- SOCKET.IO CORE (MULTI-SESSION & REAL-TIME) ---
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 1e8, // 100MB
    pingInterval: 10000,
    pingTimeout: 5000
}); 

const onlineUsers = new Map(); // username -> Set(socketIds)

const broadcastUserStatus = (username, isOnline, lastSeen = null) => {
    io.emit('user_status_change', { 
        username: username.toLowerCase(), 
        status: isOnline ? 'online' : 'offline',
        last_seen: lastSeen || new Date().toISOString()
    });
};

io.on('connection', (socket) => {
    socket.on('join', (username) => { 
        if (!username) return;
        const un = username.toLowerCase().trim();
        socket.username = un;
        
        if (!onlineUsers.has(un)) {
            onlineUsers.set(un, new Set());
            let users = getUsers();
            let uIdx = users.findIndex(u => u.username === un);
            if (uIdx !== -1) {
                users[uIdx].is_online = true;
                saveUsers(users);
            }
        }
        onlineUsers.get(un).add(socket.id);
        broadcastUserStatus(un, true);
        console.log(`[JOIN] ${un} | Sockets: ${onlineUsers.get(un).size}`);
    });

    socket.on('send_msg', (data) => {
        if (!data.s || !data.r || !data.c) return;
        const sender = data.s.toLowerCase().trim();
        const recipient = data.r.toLowerCase().trim();
        const timestamp = new Date().toISOString();
        
        const isRecipientOnline = onlineUsers.has(recipient) && onlineUsers.get(recipient).size > 0;
        const status = isRecipientOnline ? 1 : 0; 

        let content = data.c;
        if (data.type !== 'text' && data.type !== 'call' && content.startsWith('data:')) {
            content = saveBase64File(content, 'uploads', sender);
        }

        db.run("INSERT INTO messages (s, r, c, type, status, time, caption) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [sender, recipient, content, data.type || 'text', status, timestamp, data.caption || ''], 
            function(err) {
                if(err) return console.error('Insert Msg Error:', err);
                
                const msgId = this.lastID;
                db.get("SELECT * FROM messages WHERE id = ?", [msgId], (e, row) => {
                    if(row) {
                        if(onlineUsers.has(recipient)) {
                            onlineUsers.get(recipient).forEach(sid => io.to(sid).emit('new_msg', row));
                        }
                        if(onlineUsers.has(sender)) {
                            onlineUsers.get(sender).forEach(sid => io.to(sid).emit('new_msg', row));
                        }
                    }
                });
            }
        );
    });

    // --- CALL SYSTEM (SIGNALING) ---
    socket.on('call_user', (data) => {
        const { to, from, type, signal } = data;
        if (onlineUsers.has(to.toLowerCase())) {
            onlineUsers.get(to.toLowerCase()).forEach(sid => {
                io.to(sid).emit('incoming_call', { from, type, signal });
            });
        }
    });

    socket.on('accept_call', (data) => {
        const { to, signal } = data;
        if (onlineUsers.has(to.toLowerCase())) {
            onlineUsers.get(to.toLowerCase()).forEach(sid => {
                io.to(sid).emit('call_accepted', { signal });
            });
        }
    });

    socket.on('reject_call', (data) => {
        const { to } = data;
        if (onlineUsers.has(to.toLowerCase())) {
            onlineUsers.get(to.toLowerCase()).forEach(sid => {
                io.to(sid).emit('call_rejected');
            });
        }
    });

    socket.on('end_call', (data) => {
        const { to } = data;
        if (onlineUsers.has(to.toLowerCase())) {
            onlineUsers.get(to.toLowerCase()).forEach(sid => {
                io.to(sid).emit('call_ended');
            });
        }
    });
    
    // --- GROUP CALL SYSTEM ---
    socket.on('start_group_call', (data) => {
        const { group_id, caller, type } = data;
        
        // Notificar todos os membros do grupo
        db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
            if (members) {
                members.forEach(m => {
                    if (m.username !== caller && onlineUsers.has(m.username)) {
                        onlineUsers.get(m.username).forEach(sid => {
                            io.to(sid).emit('group_call_started', { group_id, caller, type });
                        });
                    }
                });
            }
        });
    });
    
    socket.on('join_group_call', (data) => {
        const { group_id, username, signal } = data;
        
        // Notificar outros participantes
        db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
            if (members) {
                members.forEach(m => {
                    if (m.username !== username && onlineUsers.has(m.username)) {
                        onlineUsers.get(m.username).forEach(sid => {
                            io.to(sid).emit('user_joined_group_call', { group_id, username, signal });
                        });
                    }
                });
            }
        });
    });
    
    socket.on('leave_group_call', (data) => {
        const { group_id, username } = data;
        
        // Notificar outros participantes
        db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
            if (members) {
                members.forEach(m => {
                    if (m.username !== username && onlineUsers.has(m.username)) {
                        onlineUsers.get(m.username).forEach(sid => {
                            io.to(sid).emit('user_left_group_call', { group_id, username });
                        });
                    }
                });
            }
        });
    });
    
    socket.on('group_call_signal', (data) => {
        const { group_id, from, to, signal } = data;
        
        if (onlineUsers.has(to)) {
            onlineUsers.get(to).forEach(sid => {
                io.to(sid).emit('group_call_signal', { group_id, from, signal });
            });
        }
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
        const { id, reaction, username } = data;
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
        const sender = data.s.toLowerCase().trim();
        const reader = data.r.toLowerCase().trim();
        
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [sender, reader], function(err) {
            if(!err && this.changes > 0) {
                if (onlineUsers.has(sender)) {
                    onlineUsers.get(sender).forEach(sid => io.to(sid).emit('msgs_read_update', { reader, sender }));
                }
                if (onlineUsers.has(reader)) {
                    onlineUsers.get(reader).forEach(sid => io.to(sid).emit('msgs_read_update', { reader, sender }));
                }
            }
        });
    });

    // --- GROUP MESSAGE EVENTS ---
    socket.on('send_group_msg', (data) => {
        if (!data.group_id || !data.sender || !data.content) return;
        const timestamp = new Date().toISOString();
        
        let content = data.content;
        if (data.type !== 'text' && data.type !== 'call' && content.startsWith('data:')) {
            content = saveBase64File(content, 'uploads', 'group_' + data.sender);
        }
        
        db.run(`INSERT INTO group_messages (group_id, sender, content, type, time, caption, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [data.group_id, data.sender, content, data.type || 'text', timestamp, data.caption || '', data.reply_to || null],
            function(err) {
                if (err) return console.error('Insert Group Msg Error:', err);
                
                const msgId = this.lastID;
                db.get(`SELECT * FROM group_messages WHERE id = ?`, [msgId], (e, row) => {
                    if (row) {
                        // Enviar para todos os membros do grupo que estão online
                        db.all(`SELECT username FROM group_members WHERE group_id = ?`, [data.group_id], (err, members) => {
                            if (members) {
                                members.forEach(m => {
                                    if (onlineUsers.has(m.username)) {
                                        onlineUsers.get(m.username).forEach(sid => {
                                            io.to(sid).emit('new_group_msg', row);
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            }
        );
    });
    
    socket.on('delete_group_msg', (data) => {
        const { id, group_id, username } = data;
        db.get(`SELECT * FROM group_messages WHERE id = ?`, [id], (err, row) => {
            if (row && row.group_id === group_id) {
                // Verificar se é o autor ou admin
                db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], (err, member) => {
                    if (member && (row.sender === username || member.role === 'admin')) {
                        db.run(`DELETE FROM group_messages WHERE id = ?`, [id], (err) => {
                            if (!err) {
                                // Notificar todos os membros
                                db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
                                    if (members) {
                                        members.forEach(m => {
                                            if (onlineUsers.has(m.username)) {
                                                onlineUsers.get(m.username).forEach(sid => {
                                                    io.to(sid).emit('group_msg_deleted', { id, group_id });
                                                });
                                            }
                                        });
                                    }
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
                    if (members) {
                        members.forEach(m => {
                            if (onlineUsers.has(m.username)) {
                                onlineUsers.get(m.username).forEach(sid => {
                                    io.to(sid).emit('group_msg_reacted', { id, reaction, group_id });
                                });
                            }
                        });
                    }
                });
            }
        });
    });
    
    socket.on('pin_group_msg', (data) => {
        const { id, group_id, username } = data;
        // Verificar se é admin
        db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], (err, member) => {
            if (member && member.role === 'admin') {
                db.run(`UPDATE group_messages SET pinned = 1 WHERE id = ?`, [id], (err) => {
                    if (!err) {
                        db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
                            if (members) {
                                members.forEach(m => {
                                    if (onlineUsers.has(m.username)) {
                                        onlineUsers.get(m.username).forEach(sid => {
                                            io.to(sid).emit('group_msg_pinned', { id, group_id });
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    });

    socket.on('friend_accepted', (data) => {
        const { by, request_id } = data;
        db.get(`SELECT requester FROM friendships WHERE id = ?`, [request_id], (err, row) => {
            if (row && onlineUsers.has(row.requester)) {
                onlineUsers.get(row.requester).forEach(sid => {
                    io.to(sid).emit('friend_accepted', { by });
                });
            }
        });
    });

    socket.on('disconnect', () => { 
        if(socket.username) {
            const un = socket.username;
            if (onlineUsers.has(un)) {
                onlineUsers.get(un).delete(socket.id);
                if (onlineUsers.get(un).size === 0) {
                    onlineUsers.delete(un);
                    let users = getUsers();
                    let uIdx = users.findIndex(u => u.username === un);
                    let lastSeen = new Date().toISOString();
                    if (uIdx !== -1) {
                        users[uIdx].is_online = false;
                        users[uIdx].last_seen = lastSeen;
                        saveUsers(users);
                    }
                    broadcastUserStatus(un, false, lastSeen);
                }
            }
        }
    });
});

// --- API ENDPOINTS ---
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

app.post('/register', async (req, res) => {
    const { username, password, display_name } = req.body;
    if (!username || !password) return res.status(400).json({error: "Campos obrigatórios"});
    
    let users = getUsers();
    const un = username.toLowerCase().trim();
    if(users.find(u => u.username === un)) return res.status(400).json({error: "Usuário já existe"});
    
    const hash = await bcrypt.hash(password, 10);
    const newUser = { 
        username: un, 
        display_name: display_name || un, 
        password: hash, 
        bio: 'Telegram 2026 Premium', 
        avatar: '', 
        bg_image: '', 
        last_seen: null,
        is_online: false
    };
    users.push(newUser);
    saveUsers(users);
    res.json({ok: true});
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = getUsers().find(u => u.username === username.toLowerCase().trim());
    if(user && await bcrypt.compare(password, user.password)) {
        const { password, ...safe } = user;
        res.json(safe);
    } else res.status(401).json({error: "Credenciais inválidas"});
});

app.get('/chats/:me', (req, res) => {
    const me = req.params.me.toLowerCase().trim();
    db.all(`
        SELECT m.*, 
        CASE WHEN s = ? THEN r ELSE s END as contact
        FROM messages m
        WHERE s = ? OR r = ?
        ORDER BY time DESC
    `, [me, me, me], (err, rows) => {
        if (err) return res.status(500).json([]);
        
        const chats = new Map();
        const users = getUsers();
        
        rows.forEach(r => {
            if (!chats.has(r.contact)) {
                const u = users.find(u => u.username === r.contact);
                chats.set(r.contact, {
                    contact: r.contact,
                    display_name: u?.display_name || r.contact,
                    avatar: u?.avatar || '',
                    is_online: u?.is_online || false,
                    last_seen: u?.last_seen || null,
                    last_msg: r.c,
                    last_time: r.time,
                    type: r.type,
                    unread: 0
                });
            }
            if (r.r === me && r.status < 2) {
                chats.get(r.contact).unread++;
            }
        });
        
        res.json(Array.from(chats.values()));
    });
});

app.get('/messages/:u1/:u2', (req, res) => {
    const u1 = req.params.u1.toLowerCase().trim();
    const u2 = req.params.u2.toLowerCase().trim();
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [u1, u2, u2, u1], (e, r) => res.json(r || []));
});

app.get('/user/:u', (req, res) => {
    const user = getUsers().find(u => u.username === req.params.u.toLowerCase().trim());
    if(user) {
        const { password, ...safe } = user;
        res.json(safe);
    } else res.status(404).json({error: "Não encontrado"});
});

app.post('/update-profile', (req, res) => {
    const { username, bio, avatar, bg_image, display_name } = req.body;
    let users = getUsers();
    let idx = users.findIndex(u => u.username === username.toLowerCase().trim());
    if(idx !== -1) {
        if(bio !== undefined) users[idx].bio = bio;
        if(display_name !== undefined) users[idx].display_name = display_name;
        if(avatar && avatar.startsWith('data:')) users[idx].avatar = saveBase64File(avatar, 'avatars', username);
        if(bg_image && bg_image.startsWith('data:')) users[idx].bg_image = saveBase64File(bg_image, 'uploads', 'bg_'+username);
        saveUsers(users);
        res.json({ok: true, user: users[idx]});
    } else res.status(404).send();
});

// --- STORIES ENDPOINTS ---
app.get('/stories', (req, res) => {
    const { viewer } = req.query;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    db.all("SELECT * FROM stories WHERE time > ? ORDER BY time DESC", [yesterday], (err, rows) => {
        if (err) return res.status(500).json([]);
        
        // Se viewer for fornecido, filtrar apenas stories de amigos
        if (viewer) {
            const viewer_lower = viewer.toLowerCase().trim();
            db.all(`SELECT * FROM friendships WHERE (requester = ? OR recipient = ?) AND status = 'accepted'`,
                [viewer_lower, viewer_lower], (err, friendships) => {
                    if (err) return res.status(500).json([]);
                    
                    const friendUsernames = friendships.map(f => 
                        f.requester === viewer_lower ? f.recipient : f.requester
                    );
                    
                    // Incluir próprios stories
                    friendUsernames.push(viewer_lower);
                    
                    const filteredStories = rows.filter(s => friendUsernames.includes(s.username));
                    
                    const users = getUsers();
                    const stories = filteredStories.map(s => {
                        const u = users.find(u => u.username === s.username);
                        let viewers = [];
                        let likes = [];
                        try { viewers = JSON.parse(s.viewers || '[]'); } catch(e) { viewers = []; }
                        try { likes = JSON.parse(s.likes || '[]'); } catch(e) { likes = []; }
                        return { 
                            ...s, 
                            display_name: u?.display_name || s.username, 
                            avatar: u?.avatar || '',
                            viewers: viewers,
                            likes: likes
                        };
                    });
                    
                    // Agrupar por usuário
                    const grouped = {};
                    stories.forEach(s => {
                        if (!grouped[s.username]) {
                            grouped[s.username] = {
                                username: s.username,
                                display_name: s.display_name,
                                avatar: s.avatar,
                                stories: []
                            };
                        }
                        grouped[s.username].stories.push(s);
                    });
                    
                    res.json(Object.values(grouped));
                });
        } else {
            const users = getUsers();
            const stories = rows.map(s => {
                const u = users.find(u => u.username === s.username);
                return { 
                    ...s, 
                    display_name: u?.display_name || s.username, 
                    avatar: u?.avatar || '',
                    viewers: JSON.parse(s.viewers || '[]'),
                    likes: JSON.parse(s.likes || '[]')
                };
            });
            res.json(stories);
        }
    });
});

app.post('/stories', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    let finalContent = content;
    if (type !== 'text' && content && content.startsWith('data:')) {
        // Garantir que subpasta exista
        const storyDir = path.join(PUBLIC_DIR, 'uploads');
        if (!fs.existsSync(storyDir)) fs.mkdirSync(storyDir, { recursive: true });
        finalContent = saveBase64File(content, 'uploads', 'story_' + username);
    }
    const time = new Date().toISOString();
    db.run("INSERT INTO stories (username, content, type, caption, bg_color, time) VALUES (?, ?, ?, ?, ?, ?)",
        [username, finalContent || '', type || 'text', caption || '', bg_color || '#FF3B30', time],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('new_story', { id: this.lastID, username, content: finalContent, type: type || 'text', caption: caption || '', bg_color: bg_color || '#FF3B30', time });
            res.json({ ok: true });
        }
    );
});

app.post('/stories/:id/view', (req, res) => {
    const { id } = req.params;
    const { username } = req.body;
    
    db.get('SELECT viewers FROM stories WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Story não encontrado' });
        
        const viewers = JSON.parse(row.viewers || '[]');
        if (!viewers.includes(username)) {
            viewers.push(username);
            db.run('UPDATE stories SET viewers = ? WHERE id = ?', [JSON.stringify(viewers), id], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ ok: true });
            });
        } else {
            res.json({ ok: true });
        }
    });
});

app.post('/stories/:id/like', (req, res) => {
    const { id } = req.params;
    const { username } = req.body;
    
    db.get('SELECT likes, username as story_owner FROM stories WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Story não encontrado' });
        
        const likes = JSON.parse(row.likes || '[]');
        const index = likes.indexOf(username);
        
        if (index === -1) {
            likes.push(username);
        } else {
            likes.splice(index, 1);
        }
        
        db.run('UPDATE stories SET likes = ? WHERE id = ?', [JSON.stringify(likes), id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            // Notificar dono do story
            if (onlineUsers.has(row.story_owner)) {
                onlineUsers.get(row.story_owner).forEach(sid => {
                    io.to(sid).emit('story_liked', { story_id: id, username, liked: index === -1 });
                });
            }
            
            res.json({ ok: true, liked: index === -1 });
        });
    });
});

app.post('/stories/:id/reply', (req, res) => {
    const { id } = req.params;
    const { username, message } = req.body;
    
    if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });
    
    const time = new Date().toISOString();
    
    db.run('INSERT INTO story_replies (story_id, username, message, time) VALUES (?, ?, ?, ?)',
        [id, username, message, time], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Buscar dono do story e notificar
            db.get('SELECT username FROM stories WHERE id = ?', [id], (err, story) => {
                if (story && onlineUsers.has(story.username)) {
                    onlineUsers.get(story.username).forEach(sid => {
                        io.to(sid).emit('story_reply', { story_id: id, from: username, message, time });
                    });
                }
            });
            
            res.json({ ok: true, id: this.lastID });
        });
});

app.get('/stories/:id/replies', (req, res) => {
    const { id } = req.params;
    
    db.all('SELECT * FROM story_replies WHERE story_id = ? ORDER BY time ASC', [id], (err, rows) => {
        if (err) return res.status(500).json([]);
        
        const users = getUsers();
        const replies = rows.map(r => {
            const u = users.find(u => u.username === r.username);
            return {
                ...r,
                display_name: u?.display_name || r.username,
                avatar: u?.avatar || ''
            };
        });
        
        res.json(replies);
    });
});

app.get('/stories/:id/viewers', (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT viewers FROM stories WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Story não encontrado' });
        
        const viewers = JSON.parse(row.viewers || '[]');
        const users = getUsers();
        
        const viewersData = viewers.map(v => {
            const u = users.find(u => u.username === v);
            return {
                username: v,
                display_name: u?.display_name || v,
                avatar: u?.avatar || ''
            };
        });
        
        res.json(viewersData);
    });
});

// --- GROUPS ENDPOINTS ---
app.post('/groups/create', (req, res) => {
    const { name, description, created_by, members } = req.body;
    if (!name || !created_by) return res.status(400).json({ error: 'Nome e criador obrigatórios' });
    
    const groupId = 'g_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString();
    
    db.run(`INSERT INTO groups (group_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        [groupId, name, description || '', created_by, createdAt],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Adicionar criador como admin
            db.run(`INSERT INTO group_members (group_id, username, role, joined_at) VALUES (?, ?, 'admin', ?)`,
                [groupId, created_by, createdAt], (err) => {
                    if (err) console.error('Erro ao adicionar criador:', err);
                });
            
            // Adicionar outros membros se fornecidos
            if (members && Array.isArray(members)) {
                members.forEach(username => {
                    if (username !== created_by) {
                        db.run(`INSERT INTO group_members (group_id, username, role, joined_at) VALUES (?, ?, 'member', ?)`,
                            [groupId, username, createdAt], (err) => {
                                if (err) console.error('Erro ao adicionar membro:', err);
                            });
                    }
                });
            }
            
            io.emit('new_group', { group_id: groupId, name, created_by });
            res.json({ ok: true, group_id: groupId });
        }
    );
});

app.get('/groups/my/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    db.all(`
        SELECT g.*, gm.role, gm.muted
        FROM groups g
        INNER JOIN group_members gm ON g.group_id = gm.group_id
        WHERE gm.username = ?
        ORDER BY g.created_at DESC
    `, [username], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows || []);
    });
});

app.get('/groups/:group_id', (req, res) => {
    const groupId = req.params.group_id;
    db.get(`SELECT * FROM groups WHERE group_id = ?`, [groupId], (err, group) => {
        if (err || !group) return res.status(404).json({ error: 'Grupo não encontrado' });
        
        db.all(`SELECT username, role, joined_at, muted FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const users = getUsers();
            const membersWithData = members.map(m => {
                const u = users.find(u => u.username === m.username);
                return {
                    ...m,
                    display_name: u?.display_name || m.username,
                    avatar: u?.avatar || '',
                    is_online: u?.is_online || false
                };
            });
            
            res.json({ ...group, members: membersWithData });
        });
    });
});

app.post('/groups/:group_id/members/add', (req, res) => {
    const { group_id } = req.params;
    const { username, added_by } = req.body;
    
    // Verificar se quem está adicionando é admin
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, added_by], (err, member) => {
        if (err || !member || member.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas admins podem adicionar membros' });
        }
        
        const joinedAt = new Date().toISOString();
        db.run(`INSERT INTO group_members (group_id, username, role, joined_at) VALUES (?, ?, 'member', ?)`,
            [group_id, username, joinedAt],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                io.emit('group_member_added', { group_id, username });
                res.json({ ok: true });
            }
        );
    });
});

app.post('/groups/:group_id/members/remove', (req, res) => {
    const { group_id } = req.params;
    const { username, removed_by } = req.body;
    
    // Verificar se quem está removendo é admin
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, removed_by], (err, member) => {
        if (err || !member || member.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas admins podem remover membros' });
        }
        
        db.run(`DELETE FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('group_member_removed', { group_id, username });
            res.json({ ok: true });
        });
    });
});

app.post('/groups/:group_id/leave', (req, res) => {
    const { group_id } = req.params;
    const { username } = req.body;
    
    db.run(`DELETE FROM group_members WHERE group_id = ? AND username = ?`, [group_id, username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('group_member_left', { group_id, username });
        res.json({ ok: true });
    });
});

app.post('/groups/:group_id/promote', (req, res) => {
    const { group_id } = req.params;
    const { username, promoted_by } = req.body;
    
    // Verificar se quem está promovendo é admin
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, promoted_by], (err, member) => {
        if (err || !member || member.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas admins podem promover membros' });
        }
        
        db.run(`UPDATE group_members SET role = 'admin' WHERE group_id = ? AND username = ?`, [group_id, username], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Notificar todos os membros
            db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
                if (members) {
                    members.forEach(m => {
                        if (onlineUsers.has(m.username)) {
                            onlineUsers.get(m.username).forEach(sid => {
                                io.to(sid).emit('member_promoted', { group_id, username });
                            });
                        }
                    });
                }
            });
            
            res.json({ ok: true });
        });
    });
});

app.post('/groups/:group_id/demote', (req, res) => {
    const { group_id } = req.params;
    const { username, demoted_by } = req.body;
    
    // Verificar se quem está rebaixando é admin
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, demoted_by], (err, member) => {
        if (err || !member || member.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas admins podem rebaixar membros' });
        }
        
        db.run(`UPDATE group_members SET role = 'member' WHERE group_id = ? AND username = ?`, [group_id, username], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Notificar todos os membros
            db.all(`SELECT username FROM group_members WHERE group_id = ?`, [group_id], (err, members) => {
                if (members) {
                    members.forEach(m => {
                        if (onlineUsers.has(m.username)) {
                            onlineUsers.get(m.username).forEach(sid => {
                                io.to(sid).emit('member_demoted', { group_id, username });
                            });
                        }
                    });
                }
            });
            
            res.json({ ok: true });
        });
    });
});

app.get('/groups/:group_id/messages', (req, res) => {
    const { group_id } = req.params;
    db.all(`SELECT * FROM group_messages WHERE group_id = ? ORDER BY time ASC`, [group_id], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows || []);
    });
});

app.post('/groups/:group_id/update', (req, res) => {
    const { group_id } = req.params;
    const { name, description, avatar, updated_by } = req.body;
    
    // Verificar se quem está atualizando é admin
    db.get(`SELECT role FROM group_members WHERE group_id = ? AND username = ?`, [group_id, updated_by], (err, member) => {
        if (err || !member || member.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas admins podem atualizar o grupo' });
        }
        
        let updates = [];
        let values = [];
        
        if (name) { updates.push('name = ?'); values.push(name); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (avatar && avatar.startsWith('data:')) {
            const savedAvatar = saveBase64File(avatar, 'avatars', 'group_' + group_id);
            updates.push('avatar = ?');
            values.push(savedAvatar);
        }
        
        if (updates.length === 0) return res.status(400).json({ error: 'Nenhuma atualização fornecida' });
        
        values.push(group_id);
        db.run(`UPDATE groups SET ${updates.join(', ')} WHERE group_id = ?`, values, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('group_updated', { group_id });
            res.json({ ok: true });
        });
    });
});

// --- FRIENDSHIP ENDPOINTS ---
app.post('/friends/request', (req, res) => {
    const { requester, recipient } = req.body;
    if (!requester || !recipient) return res.status(400).json({ error: 'Campos obrigatórios' });
    
    const req_lower = requester.toLowerCase().trim();
    const rec_lower = recipient.toLowerCase().trim();
    
    if (req_lower === rec_lower) return res.status(400).json({ error: 'Não pode adicionar a si mesmo' });
    
    // Verificar se já existe uma solicitação
    db.get(`SELECT * FROM friendships WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)`,
        [req_lower, rec_lower, rec_lower, req_lower], (err, existing) => {
            if (existing) {
                if (existing.status === 'accepted') return res.status(400).json({ error: 'Já são amigos' });
                if (existing.status === 'pending') return res.status(400).json({ error: 'Solicitação já enviada' });
            }
            
            const now = new Date().toISOString();
            db.run(`INSERT INTO friendships (requester, recipient, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`,
                [req_lower, rec_lower, now, now], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    // Notificar destinatário
                    if (onlineUsers.has(rec_lower)) {
                        onlineUsers.get(rec_lower).forEach(sid => {
                            io.to(sid).emit('friend_request', { from: req_lower, id: this.lastID });
                        });
                    }
                    
                    res.json({ ok: true, id: this.lastID });
                });
        });
});

app.post('/friends/accept', (req, res) => {
    const { request_id, username } = req.body;
    if (!request_id || !username) return res.status(400).json({ error: 'Campos obrigatórios' });
    
    const user_lower = username.toLowerCase().trim();
    const now = new Date().toISOString();
    
    db.get(`SELECT * FROM friendships WHERE id = ? AND recipient = ?`, [request_id, user_lower], (err, request) => {
        if (err || !request) return res.status(404).json({ error: 'Solicitação não encontrada' });
        
        db.run(`UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?`, [now, request_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            // Notificar solicitante
            if (onlineUsers.has(request.requester)) {
                onlineUsers.get(request.requester).forEach(sid => {
                    io.to(sid).emit('friend_accepted', { by: user_lower });
                });
            }
            
            res.json({ ok: true });
        });
    });
});

app.post('/friends/reject', (req, res) => {
    const { request_id, username } = req.body;
    if (!request_id || !username) return res.status(400).json({ error: 'Campos obrigatórios' });
    
    const user_lower = username.toLowerCase().trim();
    
    db.get(`SELECT * FROM friendships WHERE id = ? AND recipient = ?`, [request_id, user_lower], (err, request) => {
        if (err || !request) return res.status(404).json({ error: 'Solicitação não encontrada' });
        
        db.run(`DELETE FROM friendships WHERE id = ?`, [request_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
    });
});

app.post('/friends/remove', (req, res) => {
    const { username, friend } = req.body;
    if (!username || !friend) return res.status(400).json({ error: 'Campos obrigatórios' });
    
    const user_lower = username.toLowerCase().trim();
    const friend_lower = friend.toLowerCase().trim();
    
    db.run(`DELETE FROM friendships WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)`,
        [user_lower, friend_lower, friend_lower, user_lower], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            // Notificar o outro usuário
            if (onlineUsers.has(friend_lower)) {
                onlineUsers.get(friend_lower).forEach(sid => {
                    io.to(sid).emit('friend_removed', { by: user_lower });
                });
            }
            
            res.json({ ok: true });
        });
});

app.get('/friends/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    
    db.all(`SELECT * FROM friendships WHERE (requester = ? OR recipient = ?) AND status = 'accepted'`,
        [username, username], (err, rows) => {
            if (err) return res.status(500).json([]);
            
            const users = getUsers();
            const friends = rows.map(f => {
                const friendUsername = f.requester === username ? f.recipient : f.requester;
                const u = users.find(u => u.username === friendUsername);
                return {
                    username: friendUsername,
                    display_name: u?.display_name || friendUsername,
                    avatar: u?.avatar || '',
                    is_online: u?.is_online || false,
                    last_seen: u?.last_seen || null
                };
            });
            
            res.json(friends);
        });
});

app.get('/friends/requests/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    
    db.all(`SELECT * FROM friendships WHERE recipient = ? AND status = 'pending'`, [username], (err, rows) => {
        if (err) return res.status(500).json([]);
        
        const users = getUsers();
        const requests = rows.map(r => {
            const u = users.find(u => u.username === r.requester);
            return {
                id: r.id,
                username: r.requester,
                display_name: u?.display_name || r.requester,
                avatar: u?.avatar || '',
                created_at: r.created_at
            };
        });
        
        res.json(requests);
    });
});

app.get('/friends/check/:user1/:user2', (req, res) => {
    const user1 = req.params.user1.toLowerCase().trim();
    const user2 = req.params.user2.toLowerCase().trim();
    
    db.get(`SELECT * FROM friendships WHERE ((requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)) AND status = 'accepted'`,
        [user1, user2, user2, user1], (err, row) => {
            res.json({ areFriends: !!row });
        });
});

// --- HELPER: FILE SAVE ---
function saveBase64File(base64Data, subDir, prefix) {
    if (!base64Data || typeof base64Data !== 'string' || !base64Data.includes(';base64,')) return '';
    try {
        const parts = base64Data.split(';base64,');
        if (parts.length !== 2) return '';
        
        const meta = parts[0];
        const data = parts[1];
        
        // Extração de extensão mais segura
        let ext = 'png';
        const mimeMatch = meta.match(/data:(.+)/);
        if (mimeMatch && mimeMatch[1]) {
            const mime = mimeMatch[1];
            if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
            else if (mime.includes('gif')) ext = 'gif';
            else if (mime.includes('webp')) ext = 'webp';
            else if (mime.includes('mp4')) ext = 'mp4';
            else if (mime.includes('mpeg')) ext = 'mp3';
            else if (mime.includes('audio/ogg')) ext = 'ogg';
            else if (mime.includes('audio/wav')) ext = 'wav';
            else if (mime.includes('audio/webm')) ext = 'webm';
            else ext = mime.split('/')[1] || 'png';
        }

        const uniqueId = Math.random().toString(36).substring(2, 15);
        const filename = `${prefix}_${Date.now()}_${uniqueId}.${ext}`;
        const dirPath = path.join(PUBLIC_DIR, subDir);
        
        // Garantir que o diretório existe
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        
        const filepath = path.join(dirPath, filename);
        fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
        return `/${subDir}/${filename}`;
    } catch (e) {
        console.error('Save File Error:', e);
        return '';
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));
