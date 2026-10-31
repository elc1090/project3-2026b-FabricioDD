const express = require('express');
const cors = require('cors'); // <-- 1. Importação
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

const origensPermitidas = [
    'https://elc1090.github.io', // Domínio do GitHub Pages
    'http://localhost:3000',      // Permite testes locais no Node.js
    'http://127.0.0.1:5500'       // Permite testes locais via Live Server do VS Code
];

app.use(cors({
    origin: function (origin, callback) {
        // Permite requisições sem 'origin' (como Postman/cURL) ou que estejam na lista permitida
        if (!origin || origensPermitidas.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Origem não permitida pelas regras de CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Configuração da conexão com o Banco de Dados (Neon.tech)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Necessário para bancos em nuvem como o Neon
    }
});

// Teste rápido para ver se o banco está respondendo
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Erro ao conectar no banco de dados:', err.message);
    } else {
        console.log('✅ Conectado ao banco Neon.tech com sucesso!');
    }
});

// ----------------------------------------------------
// ROTAS DA API
// ----------------------------------------------------

// Rota 1: Teste simples
app.get('/', (req, res) => {
    res.send('Servidor de pontos de reciclagem online!');
});

// Rota 2: Pegar os pontos de coleta
app.get('/api/pontos', async (req, res) => {
    try {
        // Pede os pontos de coleta e também o nome de quem cadastrou fazendo um JOIN
        const query = `
            SELECT p.*, u.nome AS autor 
            FROM pontos_de_coleta p
            LEFT JOIN usuarios u ON p.usuario_id = u.id;
        `;
        const resultado = await pool.query(query);
        
        // Devolve os dados em formato JSON para o frontend
        res.json(resultado.rows);
    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro interno ao buscar os pontos' });
    }
});

// ==========================================
// ROTA: Cadastro de Usuário
// ==========================================

app.post('/api/registro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;

        // 1. Verifica se o email já está cadastrado no banco
        const verificaEmail = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (verificaEmail.rows.length > 0) {
            return res.status(400).json({ erro: 'Este email já está em uso.' });
        }

        // 2. Encripta a senha com bcrypt
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(senha, salt);

        // 3. Salva o usuário no banco (substituindo a senha real pelo Hash)
        const novoUsuario = await pool.query(
            'INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id, nome, email',
            [nome, email, senhaHash]
        );

        res.status(201).json({ 
            mensagem: 'Usuário cadastrado com sucesso!', 
            usuario: novoUsuario.rows[0] 
        });

    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro interno no servidor ao cadastrar.' });
    }
});

// ==========================================
// ROTA: Login de Usuário
// ==========================================
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;

        // 1. Busca o usuário no banco pelo email
        const userResult = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ erro: 'Email ou senha incorretos.' });
        }
        
        const usuario = userResult.rows[0];

        // 2. Compara a senha digitada com o Hash salvo no banco
        const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaValida) {
            return res.status(400).json({ erro: 'Email ou senha incorretos.' });
        }

        // 3. Se tudo estiver certo, gera o Token JWT válido por 2 horas
        const token = jwt.sign(
            { id: usuario.id, nome: usuario.nome, is_admin: usuario.is_admin }, 
            process.env.JWT_SECRET,                 
            { expiresIn: '2h' }                     
        );

        // Devolve o token e os dados para o frontend guardar
        res.json({ 
            mensagem: 'Login efetuado com sucesso!', 
            token: token,
            usuario: { id: usuario.id, nome: usuario.nome }
        });

    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro interno no servidor ao fazer login.' });
    }
});

// ==========================================
// ROTA PROTEGIDA: Inserir novo ponto de coleta
// ==========================================
app.post('/api/pontos', verificarToken, async (req, res) => {
    try {
        // Recebemos os dados do formulário do frontend
        const { nome, endereco, latitude, longitude, materiais, horario } = req.body;
        
        // Pegamos o ID do usuário diretamente do crachá validado pelo middleware!
        const usuarioId = req.usuario.id; 

        // Inserimos no banco associando ao usuário logado
        const query = `
            INSERT INTO pontos_de_coleta 
            (usuario_id, nome, endereco, latitude, longitude, materiais, horario) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            RETURNING *;
        `;
        
        const valores = [usuarioId, nome, endereco, latitude, longitude, materiais, horario];
        const resultado = await pool.query(query, valores);

        res.status(201).json({ 
            mensagem: 'Ponto de coleta salvo com sucesso!',
            ponto: resultado.rows[0]
        });

    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao salvar o ponto de coleta no banco.' });
    }
});

// ==========================================
// ROTA PROTEGIDA: Deletar um ponto de coleta
// ==========================================
app.delete('/api/pontos/:id', verificarToken, async (req, res) => {
    try {
        const pontoId = req.params.id; // ID do ponto que vem na URL (ex: /api/pontos/5)
        const usuarioId = req.usuario.id; // ID do usuário que o Middleware pegou do Token

        let query;
        let valores;

        if (req.usuario.is_admin) {
            query = `DELETE FROM pontos_de_coleta WHERE id = $1 RETURNING *;`;
            valores = [pontoId];
        } else {
            query = `DELETE FROM pontos_de_coleta WHERE id = $1 AND usuario_id = $2 RETURNING *;`;
            valores = [pontoId, usuarioId];
        }
        
        const resultado = await pool.query(query, valores);

        // Se rowCount for 0, significa que o banco não achou nenhum ponto com esse ID
        // que também pertença a esse usuário. Ou o ponto não existe, ou é de outra pessoa.
        if (resultado.rowCount === 0) {
            return res.status(403).json({ 
                erro: 'Operação negada. Este ponto não existe ou você não tem permissão para excluí-lo.' 
            });
        }

        res.json({ mensagem: 'Ponto de coleta excluído com sucesso!' });

    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao tentar excluir o ponto.' });
    }
});

// ==========================================
// ROTA PROTEGIDA: Atualizar/Editar um ponto
// ==========================================
app.put('/api/pontos/:id', verificarToken, async (req, res) => {
    try {
        const pontoId = req.params.id;
        const usuarioId = req.usuario.id;
        
        const { nome, endereco, latitude, longitude, materiais, horario } = req.body;

        // Mesma lógica de segurança no WHERE
        let query;
        let valores;

        if (req.usuario.is_admin) {
            query = `
                UPDATE pontos_de_coleta 
                SET nome = $1, endereco = $2, latitude = $3, longitude = $4, materiais = $5, horario = $6
                WHERE id = $7 RETURNING *;
            `;
            valores = [nome, endereco, latitude, longitude, materiais, horario, pontoId];
        } else {
            query = `
                UPDATE pontos_de_coleta 
                SET nome = $1, endereco = $2, latitude = $3, longitude = $4, materiais = $5, horario = $6
                WHERE id = $7 AND usuario_id = $8 RETURNING *;
            `;
            valores = [nome, endereco, latitude, longitude, materiais, horario, pontoId, usuarioId];
        }
        
        const resultado = await pool.query(query, valores);

        if (resultado.rowCount === 0) {
            return res.status(403).json({ 
                erro: 'Operação negada. Este ponto não existe ou você não tem permissão para editá-lo.' 
            });
        }

        res.json({ 
            mensagem: 'Ponto de coleta atualizado com sucesso!',
            ponto: resultado.rows[0]
        });

    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao tentar atualizar o ponto.' });
    }
});

// ==========================================
// MIDDLEWARE: Proteção de Rotas
// ==========================================
function verificarToken(req, res, next) {
    // 1. O frontend sempre deve mandar o token no cabeçalho chamado "Authorization"
    const header = req.headers['authorization'];
    
    // O padrão da web é enviar assim: "Bearer kjasdhkjashdkjah..." (separamos para pegar só o código)
    const token = header && header.split(' ')[1]; 

    if (!token) {
        return res.status(401).json({ erro: 'Acesso negado. Você precisa estar logado.' });
    }

    try {
        // 2. Tenta abrir o crachá usando a palavra secreta do .env
        const dadosDecodificados = jwt.verify(token, process.env.JWT_SECRET);
        
        // 3. Se deu certo, guardamos os dados do usuário (id, nome) dentro do pedido 
        // para que a rota que vai salvar o mapa saiba QUEM está salvando.
        req.usuario = dadosDecodificados;
        
        // 4. Manda a requisição seguir o fluxo normal
        next(); 
    } catch (erro) {
        return res.status(403).json({ erro: 'Token inválido ou expirado. Faça login novamente.' });
    }
}

// ----------------------------------------------------
// LIGAR O SERVIDOR
// ----------------------------------------------------
// O provedor vai preencher o process.env.PORT, se não preencher (no seu PC), ele usa a 3000
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});