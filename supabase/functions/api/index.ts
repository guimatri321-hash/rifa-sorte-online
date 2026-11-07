// Servidor da rifa (Supabase Edge Function "api").
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { Buffer } from "node:buffer";
import { createHmac, pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const BASE = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "") + "/functions/v1/api";

/* ------------------------------------------------------------------ */
/* Base                                                                */
/* ------------------------------------------------------------------ */

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20 });

// Listas de números vão como texto "{1,2,3}" e o SQL converte com ::int[].
const arr = (xs: number[]) => "{" + xs.map(n => Math.trunc(Number(n))).join(",") + "}";
const prep = (params: unknown[]) => params.map(p => (Array.isArray(p) ? arr(p as number[]) : p)) as any[];
function normalizar(rows: any[]) {
  for (const r of rows) if (typeof r.numeros === "string") r.numeros = r.numeros.replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
  return rows;
}
const q = async (text: string, params: unknown[] = []) => normalizar([...(await sql.unsafe(text, prep(params)))]);
type Cliente = { query: (t: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number }> };
function transacao<T>(fn: (c: Cliente) => Promise<T>): Promise<T> {
  return sql.begin(async (tx: any) => fn({
    query: async (t: string, p: unknown[] = []) => {
      const r = await tx.unsafe(t, prep(p));
      return { rows: normalizar([...r]), rowCount: r.count ?? r.length };
    },
  })) as Promise<T>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-token, authorization, apikey, x-client-info",
  "access-control-max-age": "86400",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const erro = (mensagem: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ erro: mensagem, ...extra }, status);

class HttpErro extends Error {
  constructor(public status: number, msg: string, public extra: Record<string, unknown> = {}) {
    super(msg);
  }
}

const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const texto = (s: unknown, max = 200) => String(s ?? "").trim().slice(0, max);
const primeiroNome = (s: string) => (s || "").trim().split(/\s+/)[0] || "";
function cpfValido(c: string) {
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Configurações (nome do site, Pix, regras)                           */
/* ------------------------------------------------------------------ */

const CONFIG_PADRAO = {
  nomeSite: "Rifa Sorte Online",
  chamada: "Escolha o prêmio, garanta seus números e pague por Pix.",
  whatsapp: "",
  pixChave: "",
  pixNome: "",
  pixCidade: "",
  minutosReserva: 30,
  maxPorPedido: 1000,
  regras: "",
  noiteAtivo: "sim",
  noiteInicio: 22,
  noiteFim: 8,
};
type Configuracao = typeof CONFIG_PADRAO;

async function lerConfig(): Promise<Configuracao> {
  const linhas = await q("SELECT chave, valor FROM configuracoes");
  const cfg: any = { ...CONFIG_PADRAO };
  for (const l of linhas) if (l.chave in CONFIG_PADRAO) {
    let v: any = l.valor;
    // desfaz valores gravados com aspas duplicadas
    for (let i = 0; i < 3 && typeof v === "string" && /^".*"$/s.test(v); i++) { try { v = JSON.parse(v); } catch { break; } }
    if (typeof (CONFIG_PADRAO as any)[l.chave] === "number") v = Number(v);
    cfg[l.chave] = v;
  }
  return cfg;
}
// Modo noite: entre noiteInicio e noiteFim (horário de Brasília), quem toca em "Pago" já fica com os números
// valendo; o organizador confere de manhã ("Noite (conferir)") e cancela o que não caiu.
function ehNoite(c: Configuracao) {
  if (c.noiteAtivo !== "sim") return false;
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const ini = Number(c.noiteInicio), fim = Number(c.noiteFim);
  return ini === fim ? true : ini < fim ? h >= ini && h < fim : h >= ini || h < fim;
}
const QUEM_NOITE = "Noite (conferir)";
async function confirmarSeNoite(pedidoId: number) {
  if (!ehNoite(await lerConfig())) return false;
  try { await confirmarPagamento(pedidoId, QUEM_NOITE); return true; }
  catch (e) { if (e instanceof HttpErro) return false; throw e; }
}
function configPublica(c: Configuracao) {
  return {
    nomeSite: c.nomeSite,
    chamada: c.chamada,
    whatsapp: c.whatsapp,
    regras: c.regras,
    minutosReserva: c.minutosReserva,
    maxPorPedido: c.maxPorPedido,
    pixAtivo: !!c.pixChave,
    pixNome: c.pixNome,
  };
}

/* ------------------------------------------------------------------ */
/* Pix: código "copia e cola" (BR Code) com valor e identificador      */
/* ------------------------------------------------------------------ */

const semAcento = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 .\-]/g, "").toUpperCase().trim();
const tlv = (id: string, v: string) => id + String(v.length).padStart(2, "0") + v;
function crc16(s: string) {
  let crc = 0xffff;
  for (const b of Buffer.from(s, "utf8")) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function gerarPix(chave: string, nome: string, cidade: string, valorCentavos: number, txid: string) {
  const conta = tlv("00", "br.gov.bcb.pix") + tlv("01", chave.trim());
  let p =
    tlv("00", "01") +
    tlv("26", conta) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", (valorCentavos / 100).toFixed(2)) +
    tlv("58", "BR") +
    tlv("59", (semAcento(nome) || "RECEBEDOR").slice(0, 25)) +
    tlv("60", (semAcento(cidade) || "BRASIL").slice(0, 15)) +
    tlv("62", tlv("05", txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***"));
  p += "6304";
  return p + crc16(p);
}

/* ------------------------------------------------------------------ */
/* Reservas que passaram do prazo voltam a ficar livres                */
/* ------------------------------------------------------------------ */

/* ---------- Mercado Pago (Pix com confirmação automática) ---------- */
const MP_TOKEN = () => (Deno.env.get("MP_ACCESS_TOKEN") || "").trim();
async function mp(path: string, init: RequestInit = {}) {
  const r = await fetch("https://api.mercadopago.com" + path, {
    ...init,
    headers: { authorization: "Bearer " + MP_TOKEN(), "content-type": "application/json", ...(init.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mercado Pago ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}
async function criarPixMP(ped: { id: number; codigo: string; nome: string; cpf: string; valor: number; titulo: string; minutos: number }) {
  const partes = ped.nome.trim().split(/\s+/);
  const exp = new Date(Date.now() + (ped.minutos + 15) * 60000).toISOString().replace("Z", "+00:00");
  const d = await mp("/v1/payments", {
    method: "POST",
    headers: { "x-idempotency-key": "rifa-" + ped.codigo },
    body: JSON.stringify({
      transaction_amount: ped.valor / 100,
      description: `Rifa ${ped.titulo} - pedido ${ped.codigo}`.slice(0, 120),
      payment_method_id: "pix",
      external_reference: ped.codigo,
      notification_url: `${BASE}/webhook/mercadopago`,
      date_of_expiration: exp,
      payer: {
        email: `pedido.${ped.codigo.toLowerCase()}@rifasorteonline.com.br`,
        first_name: partes[0],
        last_name: partes.slice(1).join(" ") || partes[0],
        identification: { type: "CPF", number: ped.cpf },
      },
    }),
  });
  const qr = d?.point_of_interaction?.transaction_data?.qr_code;
  if (!qr) throw new Error("Mercado Pago não devolveu o código Pix.");
  await q("UPDATE pedidos SET pix_copia_cola = $2, mp_pagamento_id = $3 WHERE id = $1", [ped.id, qr, String(d.id)]);
}
// Consulta o pagamento no Mercado Pago e confirma o pedido se o Pix caiu.
const ultimaConsulta = new Map<string, number>();
async function conferirMP(pagamentoId: string, forcar = false) {
  if (!MP_TOKEN() || !pagamentoId) return false;
  if (!forcar && (ultimaConsulta.get(pagamentoId) || 0) > Date.now() - 5000) return false;
  ultimaConsulta.set(pagamentoId, Date.now());
  const d = await mp("/v1/payments/" + encodeURIComponent(pagamentoId));
  if (d.status !== "approved") return false;
  const p = (await q("SELECT id, status, valor_centavos FROM pedidos WHERE codigo = $1 AND mp_pagamento_id = $2", [String(d.external_reference || ""), String(d.id)]))[0];
  if (!p || p.status === "pago") return false;
  if (Math.round(Number(d.transaction_amount) * 100) < p.valor_centavos) return false;
  try { await confirmarPagamento(p.id, "Mercado Pago (automático)"); return true; }
  catch (e) { if (e instanceof HttpErro) { console.error("Pix aprovado mas não confirmado:", p.id, e.message); return false; } throw e; }
}

const SQL_EXPIRAR = `
  WITH exp AS (
    UPDATE pedidos SET status = 'expirado'
    WHERE status = 'pendente' AND expira_em < now() AND comprovante_em IS NULL
    RETURNING id
  )
  DELETE FROM numeros WHERE pedido_id IN (SELECT id FROM exp)`;
const expirar = () => q(SQL_EXPIRAR);

/* ------------------------------------------------------------------ */
/* Acesso dos organizadores                                            */
/* ------------------------------------------------------------------ */

// Organizadores e chave de assinatura ficam só no banco (tabela configuracoes, nunca expostas pela API).
// Cada senha é guardada como hash PBKDF2: { nome, salt, hash }.
type Org = { nome: string; salt: string; hash: string };
let cacheOrgs: { ate: number; lista: Org[]; segredo: string } | null = null;
async function dadosAdmin() {
  if (cacheOrgs && cacheOrgs.ate > Date.now()) return cacheOrgs;
  const linhas = await q("SELECT chave, valor FROM configuracoes WHERE chave IN ('organizadores', 'adminSecret')");
  const m = new Map(linhas.map((l: any) => [l.chave, l.valor]));
  const lista = (Array.isArray(m.get("organizadores")) ? m.get("organizadores") : []) as Org[];
  const segredo = String(m.get("adminSecret") || "");
  if (!lista.length || segredo.length < 32) throw new HttpErro(503, "Painel sem organizadores configurados.");
  cacheOrgs = { ate: Date.now() + 60_000, lista, segredo };
  return cacheOrgs;
}
const organizadores = async () => (await dadosAdmin()).lista;
function senhaConfere(o: Org, senha: string) {
  const h = pbkdf2Sync(senha, o.salt, 120000, 32, "sha256").toString("hex");
  return igual(h, o.hash);
}
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const deB64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
async function assinar(exp: number, nome: string) {
  return createHmac("sha256", (await dadosAdmin()).segredo).update(`admin.${exp}.${nome}`).digest("hex");
}
async function criarToken(nome: string) {
  const exp = Date.now() + 12 * 3600 * 1000;
  return `${exp}.${b64(nome)}.${await assinar(exp, nome)}`;
}
function igual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function exigirAdmin(req: Request): Promise<string> {
  const tok = req.headers.get("x-admin-token") || "";
  const [expStr, nomeB64, sig] = tok.split(".");
  const exp = Number(expStr);
  if (!exp || !nomeB64 || !sig || exp < Date.now()) throw new HttpErro(401, "Sessão expirada. Entre de novo.");
  const nome = deB64(nomeB64);
  if (!igual(await assinar(exp, nome), sig) || !(await organizadores()).some(o => o.nome === nome))
    throw new HttpErro(401, "Sessão inválida. Entre de novo.");
  return nome;
}
const tentativas = new Map<string, { n: number; ate: number }>();
function limitarLogin(ip: string) {
  const agora = Date.now();
  const t = tentativas.get(ip);
  if (t && t.ate > agora && t.n >= 5) throw new HttpErro(429, "Muitas tentativas. Espere 15 minutos.");
  if (!t || t.ate < agora) tentativas.set(ip, { n: 1, ate: agora + 15 * 60 * 1000 });
  else t.n++;
}

/* ------------------------------------------------------------------ */
/* Formatação das rifas                                                */
/* ------------------------------------------------------------------ */

function rifaPublica(r: any) {
  return {
    id: r.id,
    titulo: r.titulo,
    descricao: r.descricao,
    preco: r.preco_centavos / 100,
    total: r.total_numeros,
    minimo: r.minimo_compra ?? 1,
    inicio: r.numero_inicial,
    extracao: r.extracao || "",
    telefone: r.telefone_suporte || "",
    dataSorteio: r.data_sorteio,
    imagem: r.imagem ? `${BASE}/imagem/${r.imagem}` : null,
    status: r.status,
    vendasAbertas: vendasAbertas(r),
    pagos: Number(r.pagos ?? 0),
    ocupados: Number(r.ocupados ?? 0),
    numeroSorteado: r.numero_sorteado,
    sorteadoEm: r.sorteado_em,
    ganhador: r.ganhador_nome ? { nome: primeiroNome(r.ganhador_nome), cidade: r.ganhador_cidade } : null,
  };
}
function vendasAbertas(r: any) {
  if (r.status !== "ativa") return false;
  if (r.data_sorteio && new Date(r.data_sorteio).getTime() < Date.now()) return false;
  return true;
}
const SQL_RIFAS = `
  SELECT r.*,
    (SELECT count(*) FROM numeros n JOIN pedidos p ON p.id = n.pedido_id WHERE n.rifa_id = r.id AND p.status = 'pago') AS pagos,
    (SELECT count(*) FROM numeros n WHERE n.rifa_id = r.id) AS ocupados,
    g.nome AS ganhador_nome, g.cidade AS ganhador_cidade
  FROM rifas r LEFT JOIN pedidos g ON g.id = r.ganhador_pedido`;

function pedidoPublico(p: any, cfg: Configuracao) {
  return {
    codigo: p.codigo,
    rifaId: p.rifa_id,
    rifaTitulo: p.titulo,
    inicio: p.numero_inicial,
    total: p.total_numeros,
    nome: primeiroNome(p.nome),
    numeros: p.numeros,
    quantidade: p.quantidade,
    valor: p.valor_centavos / 100,
    status: p.status,
    expiraEm: p.expira_em,
    pagoEm: p.pago_em,
    criadoEm: p.criado_em,
    pix: p.status === "pendente" && p.pix_copia_cola ? { copiaCola: p.pix_copia_cola, nome: cfg.pixNome } : null,
    whatsappOrganizador: p.telefone_suporte || cfg.whatsapp,
    comprovanteEnviado: !!p.comprovante_em,
    avisouPago: !!p.aviso_pago_em,
    pixAutomatico: !!p.mp_pagamento_id,
  };
}

/* ------------------------------------------------------------------ */
/* Reserva de números (transação, um pedido por vez em cada rifa)      */
/* ------------------------------------------------------------------ */

function novoCodigo() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(8) as Uint8Array, (b: number) => alfabeto[b % alfabeto.length]).join("");
}

async function reservar(rifaId: number, corpo: any) {
  const cfg = await lerConfig();
  const nome = texto(corpo.nome, 80);
  const whatsapp = soDigitos(corpo.whatsapp).slice(-11);
  const cidade = texto(corpo.cidade, 60);
  const cpf = soDigitos(corpo.cpf);
  const cep = soDigitos(corpo.cep);
  const numeroCasa = texto(corpo.numeroCasa, 12);
  if (nome.split(/\s+/).length < 2) throw new HttpErro(400, "Digite o nome completo.");
  if (!cpfValido(cpf)) throw new HttpErro(400, "CPF inválido. Confira os números.");
  if (whatsapp.length < 10) throw new HttpErro(400, "Digite o WhatsApp com DDD.");
  if (cep.length !== 8) throw new HttpErro(400, "Digite o CEP com 8 números.");
  if (!numeroCasa) throw new HttpErro(400, "Digite o número da casa.");

  const lista: number[] = Array.isArray(corpo.numeros) ? [...new Set(corpo.numeros.map(Number))] as number[] : [];
  const quantidade = lista.length || Math.floor(Number(corpo.quantidade) || 0);
  if (quantidade < 1) throw new HttpErro(400, "Escolha pelo menos um número.");
  if (quantidade > cfg.maxPorPedido) throw new HttpErro(400, `O máximo por compra é ${cfg.maxPorPedido} números.`);

  const minutosReserva = Math.max(5, Number(cfg.minutosReserva) || 30);
  let criado: any;
  try {
   criado = await transacao(async client => {
    await client.query(SQL_EXPIRAR);
    const rifa = (await client.query("SELECT * FROM rifas WHERE id = $1 FOR UPDATE", [rifaId])).rows[0];
    if (!rifa || rifa.status === "oculta") throw new HttpErro(404, "Rifa não encontrada.");
    if (!vendasAbertas(rifa)) throw new HttpErro(409, "As vendas desta rifa estão encerradas.");
    if (quantidade < rifa.minimo_compra) throw new HttpErro(400, `A compra mínima nesta rifa é de ${rifa.minimo_compra} bilhetes.`);

    let escolhidos: number[];
    if (lista.length) {
      const ini = rifa.numero_inicial, fim = ini + rifa.total_numeros - 1;
      if (lista.some(n => !Number.isInteger(n) || n < ini || n > fim))
        throw new HttpErro(400, `Os números vão de ${ini} a ${fim}.`);
      const ocupados = (
        await client.query("SELECT numero FROM numeros WHERE rifa_id = $1 AND numero = ANY($2::int[])", [rifaId, lista])
      ).rows.map((r: any) => r.numero);
      if (ocupados.length)
        throw new HttpErro(409, "Alguns números acabaram de ser comprados por outra pessoa.", { indisponiveis: ocupados });
      escolhidos = lista;
    } else {
      escolhidos = (
        await client.query(
          `SELECT n FROM generate_series($2::int, $3::int) AS n
           WHERE NOT EXISTS (SELECT 1 FROM numeros x WHERE x.rifa_id = $1 AND x.numero = n)
           ORDER BY random() LIMIT $4::int`,
          [rifaId, rifa.numero_inicial, rifa.numero_inicial + rifa.total_numeros - 1, quantidade]
        )
      ).rows.map((r: any) => r.n);
      if (escolhidos.length < quantidade)
        throw new HttpErro(409, `Só restam ${escolhidos.length} números livres nesta rifa.`);
    }
    escolhidos.sort((a, b) => a - b);

    const codigo = novoCodigo();
    const valor = rifa.preco_centavos * escolhidos.length;
    const pix = cfg.pixChave ? gerarPix(cfg.pixChave, cfg.pixNome, cfg.pixCidade, valor, codigo) : null;
    const minutos = Math.max(5, Number(cfg.minutosReserva) || 30);
    const ped = (
      await client.query(
        `INSERT INTO pedidos (codigo, rifa_id, nome, whatsapp, cidade, numeros, quantidade, valor_centavos, pix_copia_cola, expira_em, cpf, cep, numero_casa)
         VALUES ($1, $2, $3, $4, $5, $6::int[], $7, $8, $9, now() + make_interval(mins => $10::int), $11, $12, $13)
         RETURNING id, codigo`,
        [codigo, rifaId, nome, whatsapp, cidade, escolhidos, escolhidos.length, valor, pix, minutos, cpf, cep, numeroCasa]
      )
    ).rows[0];
    await client.query(
      "INSERT INTO numeros (rifa_id, numero, pedido_id) SELECT $1, unnest($2::int[]), $3",
      [rifaId, escolhidos, ped.id]
    );
    return { codigo: ped.codigo, id: ped.id, valor, titulo: rifa.titulo };
   });
  } catch (e: any) {
    if (e?.code === "23505") throw new HttpErro(409, "Alguns números acabaram de ser comprados. Tente de novo.");
    throw e;
  }
  if (MP_TOKEN()) {
    try { await criarPixMP({ id: criado.id, codigo: criado.codigo, nome, cpf, valor: criado.valor, titulo: criado.titulo, minutos: minutosReserva }); }
    catch (e) { console.error("Falha ao criar Pix no Mercado Pago (usando Pix comum):", e); }
  }
  return { codigo: criado.codigo };
}

/* ------------------------------------------------------------------ */
/* Ações do administrador                                              */
/* ------------------------------------------------------------------ */

function lerRifaForm(c: any, parcial = false) {
  const out: Record<string, unknown> = {};
  if (!parcial || "titulo" in c) {
    const t = texto(c.titulo, 120);
    if (!t) throw new HttpErro(400, "Dê um nome ao produto.");
    out.titulo = t;
  }
  if ("descricao" in c) out.descricao = texto(c.descricao, 4000);
  if (!parcial || "preco" in c) {
    const p = Math.round(Number(String(c.preco).replace(",", ".")) * 100);
    if (!(p > 0)) throw new HttpErro(400, "Digite um preço válido.");
    out.preco_centavos = p;
  }
  if ("total" in c) {
    const t = Math.floor(Number(c.total));
    if (!(t >= 1 && t <= 100000)) throw new HttpErro(400, "A quantidade de números deve ser entre 1 e 100.000.");
    out.total_numeros = t;
  }
  if ("inicio" in c) {
    const i = Number(c.inicio);
    if (i !== 0 && i !== 1) throw new HttpErro(400, "A numeração deve começar em 0 ou em 1.");
    out.numero_inicial = i;
  }
  if ("minimo" in c) {
    const mn = Math.floor(Number(c.minimo));
    if (!(mn >= 1 && mn <= 1000)) throw new HttpErro(400, "A compra mínima deve ser entre 1 e 1.000 bilhetes.");
    out.minimo_compra = mn;
  }
  if ("extracao" in c) out.extracao = texto(c.extracao, 80);
  if ("telefone" in c) out.telefone_suporte = soDigitos(c.telefone).slice(-13);
  if ("dataSorteio" in c) out.data_sorteio = c.dataSorteio ? new Date(c.dataSorteio).toISOString() : null;
  if ("imagem" in c) out.imagem = c.imagem ? texto(c.imagem, 100) : null;
  if ("status" in c) {
    if (!["ativa", "encerrada", "oculta", "sorteada"].includes(c.status)) throw new HttpErro(400, "Situação inválida.");
    out.status = c.status;
  }
  return out;
}

async function confirmarPagamento(id: number, quem: string) {
  await transacao(async client => {
    const p = (await client.query("SELECT * FROM pedidos WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!p) throw new HttpErro(404, "Pedido não encontrado.");
    if (p.status === "pago") throw new HttpErro(409, "Este pedido já está pago.");
    if (p.status === "expirado" || p.status === "cancelado") {
      // O Pix chegou depois do prazo: tenta devolver os mesmos números ao comprador.
      await client.query("SELECT 1 FROM rifas WHERE id = $1 FOR UPDATE", [p.rifa_id]);
      const ocupados = (
        await client.query("SELECT numero FROM numeros WHERE rifa_id = $1 AND numero = ANY($2::int[])", [p.rifa_id, p.numeros])
      ).rows.map((r: any) => r.numero);
      if (ocupados.length)
        throw new HttpErro(409, `Não dá para confirmar: os números ${ocupados.join(", ")} já são de outro comprador. Combine a troca ou devolva o Pix.`);
      await client.query("INSERT INTO numeros (rifa_id, numero, pedido_id) SELECT $1, unnest($2::int[]), $3", [p.rifa_id, p.numeros, p.id]);
    }
    await client.query("UPDATE pedidos SET status = 'pago', pago_em = now(), confirmado_por = $2 WHERE id = $1", [id, quem]);
  });
}

async function cancelarPedido(id: number, quem: string) {
  await transacao(async client => {
    const r = await client.query("UPDATE pedidos SET status = 'cancelado', confirmado_por = $2 WHERE id = $1 AND status IN ('pendente', 'pago') RETURNING id", [id, quem]);
    if (!r.rowCount) throw new HttpErro(409, "Só dá para cancelar pedidos pendentes ou pagos.");
    await client.query("DELETE FROM numeros WHERE pedido_id = $1", [id]);
  });
}

async function sortear(rifaId: number, numeroInformado: unknown) {
  const rifa = (await q("SELECT * FROM rifas WHERE id = $1", [rifaId]))[0];
  if (!rifa) throw new HttpErro(404, "Rifa não encontrada.");
  let alvo: any;
  if (numeroInformado !== undefined && numeroInformado !== null && numeroInformado !== "") {
    // Resultado externo (ex.: Loteria Federal): procura quem tem esse número pago.
    const n = Math.floor(Number(numeroInformado));
    const ini = rifa.numero_inicial, fim = ini + rifa.total_numeros - 1;
    if (!(n >= ini && n <= fim)) throw new HttpErro(400, `O número deve estar entre ${ini} e ${fim}.`);
    alvo = (
      await q(
        `SELECT n.numero, p.id, p.nome, p.cidade FROM numeros n JOIN pedidos p ON p.id = n.pedido_id
         WHERE n.rifa_id = $1 AND n.numero = $2 AND p.status = 'pago'`,
        [rifaId, n]
      )
    )[0];
    if (!alvo) throw new HttpErro(409, `O número ${n} não foi vendido (ou não está pago). Pela regra que você divulgou, use o próximo número válido.`);
  } else {
    const pagos = await q(
      `SELECT n.numero, p.id, p.nome, p.cidade FROM numeros n JOIN pedidos p ON p.id = n.pedido_id
       WHERE n.rifa_id = $1 AND p.status = 'pago' ORDER BY n.numero`,
      [rifaId]
    );
    if (!pagos.length) throw new HttpErro(409, "Nenhum número pago nesta rifa ainda.");
    alvo = pagos[randomInt(pagos.length)];
  }
  await q(
    "UPDATE rifas SET numero_sorteado = $2, ganhador_pedido = $3, sorteado_em = now(), status = 'sorteada' WHERE id = $1",
    [rifaId, alvo.numero, alvo.id]
  );
  return { numero: alvo.numero, nome: alvo.nome, cidade: alvo.cidade, pedidoId: alvo.id };
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const partes = url.pathname.replace(/^.*?\/api(\/|$)/, "").split("/").filter(Boolean);
  const m = req.method;
  const corpo = async () => {
    try { return await req.json(); } catch { return {}; }
  };

  try {
    /* ---------- público ---------- */
    if (m === "GET" && partes[0] === "config") return json(configPublica(await lerConfig()));

    if (m === "GET" && partes[0] === "rifas" && partes.length === 1) {
      await expirar();
      const rifas = await q(`${SQL_RIFAS} WHERE r.status <> 'oculta'
        ORDER BY (r.status = 'ativa') DESC, r.data_sorteio NULLS LAST, r.id DESC`);
      return json(rifas.map(rifaPublica));
    }

    if (m === "GET" && partes[0] === "rifas" && partes.length === 2) {
      await expirar();
      const id = Number(partes[1]);
      const r = (await q(`${SQL_RIFAS} WHERE r.id = $1 AND r.status <> 'oculta'`, [id]))[0];
      if (!r) return erro("Rifa não encontrada.", 404);
      const linhas = await q(
        `SELECT n.numero, (p.status = 'pago') AS pago FROM numeros n JOIN pedidos p ON p.id = n.pedido_id WHERE n.rifa_id = $1`,
        [id]
      );
      const pagos: number[] = [], reservados: number[] = [];
      for (const l of linhas) (l.pago ? pagos : reservados).push(l.numero);
      return json({ ...rifaPublica(r), pagosLista: pagos, reservadosLista: reservados });
    }

    if (m === "POST" && partes[0] === "rifas" && partes[2] === "reservar") {
      return json(await reservar(Number(partes[1]), await corpo()), 201);
    }

    if (m === "GET" && partes[0] === "pedidos" && partes[1]) {
      await expirar();
      const p = (
        await q("SELECT p.*, r.titulo, r.numero_inicial, r.total_numeros, r.telefone_suporte FROM pedidos p JOIN rifas r ON r.id = p.rifa_id WHERE p.codigo = $1", [partes[1].toUpperCase()])
      )[0];
      if (!p) return erro("Pedido não encontrado.", 404);
      if (p.mp_pagamento_id && (p.status === "pendente" || p.status === "expirado")) {
        try { if (await conferirMP(p.mp_pagamento_id)) { p.status = "pago"; } } catch (e) { console.error(e); }
      }
      return json(pedidoPublico(p, await lerConfig()));
    }

    if (m === "POST" && partes[0] === "pedidos" && partes[1] && partes[2] === "comprovante") {
      const tipo = (req.headers.get("content-type") || "").split(";")[0].trim();
      if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(tipo)) return erro("Envie uma foto ou print (JPG/PNG) ou um PDF do comprovante.");
      const dados = await req.arrayBuffer();
      if (!dados.byteLength) return erro("Arquivo vazio.");
      if (dados.byteLength > 6 * 1024 * 1024) return erro("O arquivo deve ter até 6 MB.");
      const p = (await q("SELECT id, status FROM pedidos WHERE codigo = $1", [partes[1].toUpperCase()]))[0];
      if (!p) return erro("Pedido não encontrado.", 404);
      if (p.status === "cancelado") return erro("Este pedido foi cancelado. Fale com o organizador.", 409);
      const n = Number((await q("SELECT count(*) AS n FROM comprovantes WHERE pedido_id = $1", [p.id]))[0].n);
      if (n >= 5) return erro("Você já enviou comprovantes para este pedido. Aguarde a confirmação.", 429);
      await q("INSERT INTO comprovantes (pedido_id, tipo, dados) VALUES ($1, $2, decode($3, 'base64'))", [p.id, tipo, Buffer.from(dados).toString("base64")]);
      await q("UPDATE pedidos SET comprovante_em = now() WHERE id = $1", [p.id]);
      await q("UPDATE pedidos SET aviso_pago_em = COALESCE(aviso_pago_em, now()) WHERE id = $1", [p.id]);
      const confirmado = p.status !== "pago" && (await confirmarSeNoite(p.id));
      return json({ ok: true, confirmado }, 201);
    }

    // Comprador avisa que pagou: o pedido sobe no painel e ganha mais 15 minutos para o organizador conferir.
    if (m === "POST" && partes[0] === "pedidos" && partes[1] && partes[2] === "pago") {
      const r = await q(
        `UPDATE pedidos SET aviso_pago_em = now(), expira_em = GREATEST(expira_em, now() + interval '15 minutes')
         WHERE codigo = $1 AND status = 'pendente' AND aviso_pago_em IS NULL RETURNING id`,
        [partes[1].toUpperCase()]
      );
      const p = (await q("SELECT id, status FROM pedidos WHERE codigo = $1", [partes[1].toUpperCase()]))[0];
      if (!p) return erro("Pedido não encontrado.", 404);
      if (p.status === "pendente" && (await confirmarSeNoite(p.id))) p.status = "pago";
      return json({ ok: true, status: p.status, avisado: r.length > 0 });
    }

    // Aviso do Mercado Pago: sempre reconsulta o pagamento na API antes de confirmar.
    if (partes[0] === "webhook" && partes[1] === "mercadopago") {
      let id = url.searchParams.get("data.id") || url.searchParams.get("id") || "";
      const tipo = url.searchParams.get("type") || url.searchParams.get("topic") || "";
      if (m === "POST") { const c: any = await corpo(); id = String(c?.data?.id || id || ""); }
      if (id && (!tipo || tipo === "payment")) {
        try { await conferirMP(id, true); } catch (e) { console.error("webhook MP:", e); }
      }
      return json({ ok: true });
    }

    if (m === "GET" && partes[0] === "meus") {
      const w = soDigitos(url.searchParams.get("whatsapp")).slice(-11);
      if (w.length < 10) return erro("Digite o WhatsApp com DDD.");
      await expirar();
      const cfg = await lerConfig();
      const lista = await q(
        `SELECT p.*, r.titulo, r.numero_inicial, r.total_numeros, r.telefone_suporte FROM pedidos p JOIN rifas r ON r.id = p.rifa_id
         WHERE p.whatsapp = $1 AND p.status IN ('pendente', 'pago') ORDER BY p.criado_em DESC LIMIT 50`,
        [w]
      );
      return json(lista.map(p => pedidoPublico(p, cfg)));
    }

    if (m === "GET" && partes[0] === "imagem" && partes[1]) {
      const r = (await q("SELECT tipo, encode(dados, 'base64') AS b64 FROM imagens WHERE chave = $1", [partes[1]]))[0];
      if (!r) return new Response("Imagem não encontrada", { status: 404, headers: CORS });
      return new Response(Buffer.from(r.b64.replace(/\s/g, ""), "base64"), {
        headers: { ...CORS, "content-type": r.tipo || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    /* ---------- administrador ---------- */
    if (partes[0] === "admin") {
      if (m === "GET" && partes[1] === "organizadores") return json((await organizadores()).map(o => o.nome));
      if (m === "POST" && partes[1] === "login") {
        limitarLogin((req.headers.get("x-forwarded-for") || "?").split(",")[0].trim());
        const { nome, senha } = await corpo();
        const quem = (await organizadores()).find(o => o.nome === String(nome || ""));
        if (!quem || !senhaConfere(quem, String(senha || ""))) return erro("Nome ou senha incorretos.", 401);
        return json({ token: await criarToken(quem.nome), nome: quem.nome });
      }
      const organizador = await exigirAdmin(req);
      await expirar();

      if (m === "GET" && partes[1] === "resumo") {
        const rifas = await q(`${SQL_RIFAS} ORDER BY r.id DESC`);
        const totais = await q(
          `SELECT rifa_id,
             count(*) FILTER (WHERE status = 'pendente') AS pendentes,
             count(*) FILTER (WHERE status = 'pendente' AND (aviso_pago_em IS NOT NULL OR comprovante_em IS NOT NULL)) AS avisos,
             count(*) FILTER (WHERE status = 'pago' AND confirmado_por = 'Noite (conferir)') AS conferir,
             COALESCE(sum(valor_centavos) FILTER (WHERE status = 'pago'), 0) AS recebido,
             COALESCE(sum(valor_centavos) FILTER (WHERE status = 'pendente'), 0) AS a_receber
           FROM pedidos GROUP BY rifa_id`
        );
        const porRifa = new Map(totais.map(t => [t.rifa_id, t]));
        return json(
          rifas.map(r => {
            const t: any = porRifa.get(r.id) || {};
            return {
              ...rifaPublica(r),
              ganhadorCompleto: r.ganhador_nome || null,
              pendentes: Number(t.pendentes || 0),
              avisos: Number(t.avisos || 0),
              conferir: Number(t.conferir || 0),
              recebido: Number(t.recebido || 0) / 100,
              aReceber: Number(t.a_receber || 0) / 100,
            };
          })
        );
      }

      if (m === "POST" && partes[1] === "rifas" && partes.length === 2) {
        const d = lerRifaForm(await corpo());
        const cols = Object.keys(d);
        const r = (
          await q(
            `INSERT INTO rifas (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")}) RETURNING id`,
            Object.values(d)
          )
        )[0];
        return json({ id: r.id }, 201);
      }

      if (m === "PUT" && partes[1] === "rifas" && partes[2]) {
        const d = lerRifaForm(await corpo(), true);
        const cols = Object.keys(d);
        if (!cols.length) return erro("Nada para alterar.");
        if ("total_numeros" in d || "numero_inicial" in d) {
          const atual = (await q("SELECT numero_inicial, total_numeros FROM rifas WHERE id = $1", [Number(partes[2])]))[0];
          if (!atual) return erro("Rifa não encontrada.", 404);
          const ini = Number(d.numero_inicial ?? atual.numero_inicial), fim = ini + Number(d.total_numeros ?? atual.total_numeros) - 1;
          const lim = (await q("SELECT min(numero) AS a, max(numero) AS b FROM numeros WHERE rifa_id = $1", [Number(partes[2])]))[0];
          if (lim?.a != null && (lim.a < ini || lim.b > fim))
            return erro("Já existem bilhetes vendidos fora dessa numeração. Mantenha a quantidade e o início atuais.");
        }
        await q(
          `UPDATE rifas SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`,
          [Number(partes[2]), ...Object.values(d)]
        );
        return json({ ok: true });
      }

      if (m === "POST" && partes[1] === "rifas" && partes[3] === "sortear") {
        const c = await corpo();
        return json(await sortear(Number(partes[2]), c.numero));
      }

      if (m === "POST" && partes[1] === "rifas" && partes[3] === "desfazer-sorteio") {
        await q("UPDATE rifas SET numero_sorteado = NULL, ganhador_pedido = NULL, sorteado_em = NULL, status = 'encerrada' WHERE id = $1", [Number(partes[2])]);
        return json({ ok: true });
      }

      if (m === "POST" && partes[1] === "imagem") {
        const tipo = req.headers.get("content-type") || "";
        if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(tipo)) return erro("Envie uma imagem JPG, PNG ou WEBP.");
        const dados = await req.arrayBuffer();
        if (dados.byteLength > 4 * 1024 * 1024) return erro("A imagem deve ter até 4 MB.");
        const chave = randomBytes(12).toString("hex");
        await q("INSERT INTO imagens (chave, tipo, dados) VALUES ($1, $2, decode($3, 'base64'))", [chave, tipo, Buffer.from(dados).toString("base64")]);
        return json({ imagem: chave }, 201);
      }

      if (m === "GET" && partes[1] === "pedidos" && !partes[2]) {
        const filtros: string[] = [], params: unknown[] = [];
        const rifa = url.searchParams.get("rifa"), status = url.searchParams.get("status"), busca = texto(url.searchParams.get("busca"), 60);
        if (rifa) { params.push(Number(rifa)); filtros.push(`p.rifa_id = $${params.length}`); }
        if (status === "conferir") { params.push(QUEM_NOITE); filtros.push(`p.status = 'pago' AND p.confirmado_por = $${params.length}`); }
        else if (status) { params.push(status); filtros.push(`p.status = $${params.length}`); }
        if (busca) {
          const n = Number(busca);
          params.push(`%${busca.toLowerCase()}%`);
          const soNum = soDigitos(busca);
          let cond = `(lower(p.nome) LIKE $${params.length} OR p.whatsapp LIKE $${params.length} OR lower(p.cidade) LIKE $${params.length} OR p.codigo LIKE upper($${params.length})`;
          if (soNum.length >= 3) { params.push(`%${soNum}%`); cond += ` OR p.cpf LIKE $${params.length} OR p.whatsapp LIKE $${params.length}`; }
          if (Number.isInteger(n) && n >= 0 && /^\d+$/.test(busca)) { params.push(n); cond += ` OR $${params.length} = ANY(p.numeros)`; }
          filtros.push(cond + ")");
        }
        const lista = await q(
          `SELECT p.*, r.titulo FROM pedidos p JOIN rifas r ON r.id = p.rifa_id
           ${filtros.length ? "WHERE " + filtros.join(" AND ") : ""}
           ORDER BY ((p.comprovante_em IS NOT NULL OR p.aviso_pago_em IS NOT NULL) AND p.status = 'pendente') DESC, p.criado_em DESC LIMIT 1000`,
          params
        );
        return json(
          lista.map(p => ({
            id: p.id, codigo: p.codigo, rifaId: p.rifa_id, rifaTitulo: p.titulo, nome: p.nome, whatsapp: p.whatsapp,
            cidade: p.cidade, cpf: p.cpf, cep: p.cep, numeroCasa: p.numero_casa, numeros: p.numeros, quantidade: p.quantidade, valor: p.valor_centavos / 100,
            status: p.status, criadoEm: p.criado_em, expiraEm: p.expira_em, pagoEm: p.pago_em, por: p.confirmado_por, comprovanteEm: p.comprovante_em, avisoPagoEm: p.aviso_pago_em,
          }))
        );
      }

      if (m === "GET" && partes[1] === "pedidos" && partes[3] === "comprovante") {
        const r = (await q("SELECT tipo, encode(dados, 'base64') AS b64 FROM comprovantes WHERE pedido_id = $1 ORDER BY id DESC LIMIT 1", [Number(partes[2])]))[0];
        if (!r) return erro("Nenhum comprovante enviado.", 404);
        return new Response(Buffer.from(r.b64.replace(/\s/g, ""), "base64"), { headers: { ...CORS, "content-type": r.tipo, "cache-control": "no-store" } });
      }

      if (m === "POST" && partes[1] === "pedidos" && partes[3] === "confirmar") {
        await confirmarPagamento(Number(partes[2]), organizador);
        return json({ ok: true });
      }
      if (m === "POST" && partes[1] === "pedidos" && partes[3] === "conferido") {
        const r = await q("UPDATE pedidos SET confirmado_por = $2 WHERE id = $1 AND status = 'pago' RETURNING id", [Number(partes[2]), organizador]);
        if (!r.length) return erro("Só dá para marcar como conferido um pedido pago.", 409);
        return json({ ok: true });
      }
      if (m === "POST" && partes[1] === "pedidos" && partes[3] === "cancelar") {
        await cancelarPedido(Number(partes[2]), organizador);
        return json({ ok: true });
      }

      if (m === "GET" && partes[1] === "config") return json({ ...(await lerConfig()), mercadoPagoAtivo: !!MP_TOKEN() });
      if (m === "PUT" && partes[1] === "config") {
        const c = await corpo();
        const limpo: Record<string, unknown> = {};
        for (const k of Object.keys(CONFIG_PADRAO) as (keyof Configuracao)[]) {
          if (!(k in c)) continue;
          if (k === "minutosReserva") limpo[k] = Math.min(1440, Math.max(5, Math.floor(Number(c[k]) || 30)));
          else if (k === "maxPorPedido") limpo[k] = Math.min(10000, Math.max(1, Math.floor(Number(c[k]) || 1000)));
          else if (k === "noiteInicio" || k === "noiteFim") limpo[k] = Math.min(23, Math.max(0, Math.floor(Number(c[k]) || 0)));
          else if (k === "noiteAtivo") limpo[k] = c[k] === "sim" || c[k] === true ? "sim" : "nao";
          else limpo[k] = texto(c[k], k === "regras" ? 4000 : 140);
        }
        for (const [k, v] of Object.entries(limpo))
          await q("INSERT INTO configuracoes (chave, valor) VALUES ($1, ($2::text)::jsonb) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [k, JSON.stringify(v)]);
        return json(await lerConfig());
      }
    }

    return erro("Endereço não encontrado.", 404);
  } catch (e: any) {
    if (e instanceof HttpErro) return erro(e.message, e.status, e.extra);
    console.error(e);
    return erro("Algo deu errado no servidor. Tente de novo em instantes.", 500);
  }
});
