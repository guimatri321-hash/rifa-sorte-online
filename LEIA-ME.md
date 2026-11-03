# Rifa Sorte Online

- **Site das pessoas:** `index.html`
- **Painel dos organizadores:** `admin.html` (abre em `/admin`), senha 103425 para Guilherme e Sócio
- **Servidor e banco:** Supabase, projeto `rifa-sorte-online` (São Paulo). O código do servidor está em `supabase/functions/api/index.ts`.
- **Fotos dos prêmios:** pasta `fotos/`

As páginas são arquivos estáticos e podem ficar em qualquer hospedagem (GitHub Pages, Cloudflare Pages). Todas falam com o mesmo servidor no Supabase, então as compras aparecem no painel na hora.

Para trocar as senhas sem mexer no código: no Supabase, em Edge Functions → Secrets, crie `ORGANIZADORES` com o valor `Guilherme:senha1;Sócio:senha2`.
