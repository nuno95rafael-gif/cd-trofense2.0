from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import uuid
import asyncio
import logging
import base64
from datetime import datetime, timezone, timedelta
from typing import Optional, Any

import bcrypt
import jwt
import httpx
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, UploadFile, File, Form, Query, Header
from fastapi.responses import Response as FastAPIResponse
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, EmailStr

from formulas import compute_all
from db import get_client

# ---------- Setup ----------
sb = get_client()
PHOTOS_BUCKET = "photos"

app = FastAPI(title="CD Trofense API")
api = APIRouter(prefix="/api")

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = "HS256"
ACCESS_TTL_MIN = 60 * 12  # 12 horas

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("trofense")


async def db_call(fn):
    """Executa uma chamada (síncrona) ao cliente Supabase numa thread, para
    não bloquear o event loop do FastAPI."""
    return await asyncio.to_thread(fn)


def content_type_for(ext: str) -> str:
    ext = (ext or "").lower().lstrip(".")
    return {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
    }.get(ext, "image/jpeg")


# ---------- Helpers ----------
def hash_password(p: str) -> str:
    return bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode()


def verify_password(p: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(p.encode(), h.encode())
    except Exception:
        return False


def create_token(user_id: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TTL_MIN),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        h = request.headers.get("Authorization", "")
        if h.startswith("Bearer "):
            token = h[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Não autenticado")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Sessão expirada")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token inválido")
    res = await db_call(lambda: sb.table("users").select("*").eq("id", payload["sub"]).maybe_single().execute())
    user = res.data if res else None
    if not user or not user.get("active", True):
        raise HTTPException(status_code=401, detail="Utilizador inválido")
    user.pop("password_hash", None)
    return user


async def require_editor(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "editor":
        raise HTTPException(status_code=403, detail="Apenas editores podem executar esta ação")
    return user


# ---------- Models ----------
class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserCreateIn(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: str = "viewer"  # editor | viewer


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    role: str
    active: bool = True
    created_at: str


class AthleteIn(BaseModel):
    nome: str
    posicao: Optional[str] = None
    sexo: str = "M"  # M | F
    etnia: str = "caucasiano"
    altura_cm: Optional[float] = None
    idade: Optional[float] = None
    peso_normal_kg: Optional[float] = None
    peso_atual_kg: Optional[float] = None
    email: Optional[str] = None
    contacto: Optional[str] = None
    dieta: Optional[str] = None
    agua_l: Optional[float] = None
    suplementacao: Optional[str] = None
    cafeina: Optional[str] = None
    preferencia_jogo: Optional[str] = None
    sabor_batido: Optional[str] = None
    intervalo: Optional[str] = None
    nao_gosta: Optional[str] = None
    sono_h: Optional[float] = None
    notas: Optional[str] = None


class EvaluationIn(BaseModel):
    date: str  # ISO
    peso_kg: Optional[float] = None
    age_at_eval: Optional[float] = None
    pregas: dict = Field(default_factory=dict)
    perimetros: dict = Field(default_factory=dict)
    notas: Optional[str] = None


class WeighinIn(BaseModel):
    date: str
    peso_kg: float


class GoalIn(BaseModel):
    bf_target_pct: Optional[float] = None
    imc_target: Optional[float] = None
    # métrica de referência: "bf" (% MG) ou "imc". Determina qual peso alvo é mostrado.
    primary_metric: Optional[str] = "bf"


# ---------- Email (Emergent-managed Resend) ----------
EMAIL_BASE_URL = "https://integrations.emergentagent.com"


class SendReportIn(BaseModel):
    recipient_email: EmailStr
    subject: Optional[str] = None
    message: Optional[str] = None
    pdf_base64: str  # PDF gerado no cliente (jsPDF) codificado em base64
    filename: Optional[str] = "relatorio.pdf"


@api.post("/athletes/{aid}/send-report")
async def send_athlete_report(aid: str, body: SendReportIn, user: dict = Depends(require_editor)):
    """Envia o relatório PDF do atleta por email. Usa Resend diretamente (suporta anexos).
    Requer:
      - RESEND_API_KEY (re_...) — chave da conta Resend
      - RESEND_FROM_EMAIL — email de envio (ex: relatorios@trofense.pt) — precisa de domínio verificado.
        Alternativa (só para testar): 'onboarding@resend.dev' (o domínio de fallback do Resend).
    """
    resend_key = os.environ.get("RESEND_API_KEY")
    from_email = os.environ.get("RESEND_FROM_EMAIL", "onboarding@resend.dev")
    from_name = os.environ.get("EMAIL_FROM_NAME", "CD Trofense · Departamento Médico")

    if not resend_key:
        raise HTTPException(
            status_code=503,
            detail="Envio de email não configurado. Peça ao administrador para adicionar RESEND_API_KEY ao backend."
        )

    res = await db_call(lambda: sb.table("athletes").select("*").eq("id", aid).maybe_single().execute())
    athlete = res.data if res else None
    if not athlete:
        raise HTTPException(status_code=404, detail="Atleta não encontrado")

    subject = body.subject or f"Avaliação de composição corporal · {athlete.get('nome', 'Atleta')}"
    msg_html = (body.message or "").replace("\n", "<br>") if body.message else ""

    html_content = f"""
    <div style="font-family: Helvetica, Arial, sans-serif; color:#1B2C5A; max-width: 640px; margin: 0 auto;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; background:#1B2C5A; color:#fff;">
        <tr>
          <td style="padding: 20px;">
            <div style="font-size: 12px; letter-spacing: 2px; color:#DC1928; font-weight:bold;">CLUBE DESPORTIVO TROFENSE</div>
            <div style="font-size: 18px; margin-top: 4px; font-weight:bold;">Departamento Médico · Composição Corporal</div>
          </td>
        </tr>
      </table>
      <div style="padding: 24px 20px; background:#f8f9fb;">
        <p style="margin:0 0 12px 0;">Olá <b>{athlete.get('nome', '')}</b>,</p>
        <p style="margin:0 0 12px 0;">Segue em anexo o teu relatório individual de composição corporal.</p>
        {f'<div style="margin:16px 0; padding:12px; border-left:3px solid #DC1928; background:#fff; font-size:14px;">{msg_html}</div>' if msg_html else ''}
        <p style="margin:16px 0 4px 0; font-size:12px; color:#666;">Enviado por {user.get('name', 'Departamento Médico')} — CD Trofense.</p>
      </div>
      <div style="text-align:center; padding: 12px; font-size: 11px; color:#999; font-style:italic;">
        Desde 1930 · história, paixão e glória
      </div>
    </div>
    """

    payload = {
        "from": f"{from_name} <{from_email}>",
        "to": [body.recipient_email],
        "subject": subject,
        "html": html_content,
        "attachments": [{
            "filename": body.filename or "relatorio.pdf",
            "content": body.pdf_base64,
        }],
    }

    try:
        async with httpx.AsyncClient(timeout=45) as httpc:
            resp = await httpc.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {resend_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        resp.raise_for_status()
        return {"ok": True, "email_id": resp.json().get("id")}
    except httpx.HTTPStatusError as e:
        logger.error("send-report failed: %s %s", e.response.status_code, e.response.text)
        try:
            err = e.response.json()
            detail = err.get("message") or err.get("error") or f"HTTP {e.response.status_code}"
        except Exception:
            detail = f"HTTP {e.response.status_code}"
        raise HTTPException(status_code=502, detail=f"Falha no envio: {detail}")
    except Exception as e:
        logger.exception("send-report error")
        raise HTTPException(status_code=500, detail=f"Erro ao enviar email: {e}")


# ---------- Auth ----------
@api.post("/auth/login")
async def login(body: LoginIn, response: Response):
    email = body.email.lower().strip()
    res = await db_call(lambda: sb.table("users").select("*").eq("email", email).maybe_single().execute())
    user = res.data if res else None
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenciais inválidas")
    if not user.get("active", True):
        raise HTTPException(status_code=403, detail="Conta desativada")
    token = create_token(user["id"], user["role"])
    response.set_cookie(
        "access_token",
        token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=ACCESS_TTL_MIN * 60,
        path="/",
    )
    user.pop("password_hash", None)
    return {"user": user, "token": token}


@api.post("/auth/logout")
async def logout(response: Response, _: dict = Depends(get_current_user)):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


# ---------- Users (editor only) ----------
@api.get("/users")
async def list_users(_: dict = Depends(require_editor)):
    res = await db_call(lambda: sb.table("users").select("id,email,name,role,active,created_at").execute())
    return res.data


@api.post("/users")
async def create_user(body: UserCreateIn, _: dict = Depends(require_editor)):
    email = body.email.lower().strip()
    existing = await db_call(lambda: sb.table("users").select("id").eq("email", email).maybe_single().execute())
    if existing and existing.data:
        raise HTTPException(status_code=400, detail="Email já existe")
    if body.role not in ("editor", "viewer"):
        raise HTTPException(status_code=400, detail="Papel inválido")
    doc = {
        "id": new_id(),
        "email": email,
        "name": body.name,
        "role": body.role,
        "active": True,
        "password_hash": hash_password(body.password),
        "created_at": now_iso(),
    }
    res = await db_call(lambda: sb.table("users").insert(doc).execute())
    created = res.data[0]
    created.pop("password_hash", None)
    return created


@api.patch("/users/{user_id}")
async def toggle_user(user_id: str, active: bool = Query(...), current: dict = Depends(require_editor)):
    if user_id == current["id"] and not active:
        raise HTTPException(status_code=400, detail="Não pode desativar-se a si próprio")
    res = await db_call(lambda: sb.table("users").update({"active": active}).eq("id", user_id).execute())
    if not res.data:
        raise HTTPException(status_code=404, detail="Utilizador não encontrado")
    return {"ok": True}


@api.delete("/users/{user_id}")
async def delete_user(user_id: str, current: dict = Depends(require_editor)):
    if user_id == current["id"]:
        raise HTTPException(status_code=400, detail="Não pode apagar-se a si próprio")
    res = await db_call(lambda: sb.table("users").delete().eq("id", user_id).execute())
    if not res.data:
        raise HTTPException(status_code=404, detail="Utilizador não encontrado")
    return {"ok": True}


# ---------- Athletes ----------
@api.get("/athletes")
async def list_athletes(_: dict = Depends(get_current_user)):
    res = await db_call(lambda: sb.table("athletes").select("*").order("nome").execute())
    docs = res.data
    for a in docs:
        last_res = await db_call(
            lambda aid=a["id"]: sb.table("evaluations").select("metrics,date,peso_kg")
            .eq("athlete_id", aid).order("date", desc=True).limit(1).execute()
        )
        if last_res.data:
            last = last_res.data[0]
            a["last_metrics"] = last.get("metrics")
            a["last_evaluation_date"] = last.get("date")
            a["last_eval_weight"] = last.get("peso_kg")
        lw_res = await db_call(
            lambda aid=a["id"]: sb.table("weighins").select("peso_kg,date")
            .eq("athlete_id", aid).order("date", desc=True).limit(1).execute()
        )
        if lw_res.data:
            lw = lw_res.data[0]
            a["last_weight"] = lw.get("peso_kg")
            a["last_weight_date"] = lw.get("date")
        a["display_weight"] = (
            a.get("last_weight")
            or a.get("last_eval_weight")
            or a.get("peso_atual_kg")
        )
    return docs


@api.post("/athletes")
async def create_athlete(body: AthleteIn, user: dict = Depends(require_editor)):
    doc = body.model_dump()
    doc["id"] = new_id()
    doc["created_at"] = now_iso()
    doc["created_by"] = user["id"]
    doc["goal"] = None
    res = await db_call(lambda: sb.table("athletes").insert(doc).execute())
    return res.data[0]


@api.get("/athletes/{aid}")
async def get_athlete(aid: str, _: dict = Depends(get_current_user)):
    res = await db_call(lambda: sb.table("athletes").select("*").eq("id", aid).maybe_single().execute())
    a = res.data if res else None
    if not a:
        raise HTTPException(status_code=404, detail="Atleta não encontrado")
    return a


@api.put("/athletes/{aid}")
async def update_athlete(aid: str, body: AthleteIn, _: dict = Depends(require_editor)):
    res = await db_call(lambda: sb.table("athletes").update(body.model_dump()).eq("id", aid).execute())
    if not res.data:
        raise HTTPException(status_code=404, detail="Atleta não encontrado")
    return res.data[0]


@api.delete("/athletes/{aid}")
async def delete_athlete(aid: str, _: dict = Depends(require_editor)):
    # remove os ficheiros do storage antes de apagar o atleta (as linhas de
    # evaluations/weighins/photos são removidas em cascata pela BD)
    photos_res = await db_call(lambda: sb.table("photos").select("storage_path").eq("athlete_id", aid).execute())
    paths = [p["storage_path"] for p in photos_res.data if p.get("storage_path")]
    if paths:
        await db_call(lambda: sb.storage.from_(PHOTOS_BUCKET).remove(paths))
    await db_call(lambda: sb.table("athletes").delete().eq("id", aid).execute())
    return {"ok": True}


@api.put("/athletes/{aid}/goal")
async def set_goal(aid: str, body: GoalIn, _: dict = Depends(require_editor)):
    primary = body.primary_metric if body.primary_metric in ("bf", "imc") else "bf"
    goal_doc = {
        "bf_target_pct": body.bf_target_pct,
        "imc_target": body.imc_target,
        "primary_metric": primary,
        "updated_at": now_iso(),
    }
    res = await db_call(lambda: sb.table("athletes").update({"goal": goal_doc}).eq("id", aid).execute())
    if not res.data:
        raise HTTPException(status_code=404, detail="Atleta não encontrado")
    return {"ok": True}


@api.post("/athletes/{aid}/recompute")
async def recompute_metrics(aid: str, _: dict = Depends(require_editor)):
    res = await db_call(lambda: sb.table("athletes").select("*").eq("id", aid).maybe_single().execute())
    a = res.data if res else None
    if not a:
        raise HTTPException(status_code=404, detail="Atleta não encontrado")
    evs_res = await db_call(lambda: sb.table("evaluations").select("*").eq("athlete_id", aid).execute())
    evs = evs_res.data
    for e in evs:
        m = compute_all(e, a)
        await db_call(lambda eid=e["id"], m=m: sb.table("evaluations").update({"metrics": m}).eq("id", eid).execute())
    return {"ok": True, "updated": len(evs)}


@api.post("/admin/recompute-all")
async def recompute_all(_: dict = Depends(require_editor)):
    total = 0
    athletes_res = await db_call(lambda: sb.table("athletes").select("*").execute())
    for a in athletes_res.data:
        evs_res = await db_call(lambda aid=a["id"]: sb.table("evaluations").select("*").eq("athlete_id", aid).execute())
        for e in evs_res.data:
            m = compute_all(e, a)
            await db_call(lambda eid=e["id"], m=m: sb.table("evaluations").update({"metrics": m}).eq("id", eid).execute())
            total += 1
    return {"ok": True, "updated": total}


# ---------- Evaluations ----------
async def _enrich_user_names(docs: list) -> list:
    """Adiciona campo created_by_name aos docs (lookup em users)."""
    ids = list({d["created_by"] for d in docs if d.get("created_by")})
    if not ids:
        return docs
    res = await db_call(lambda: sb.table("users").select("id,name,email").in_("id", ids).execute())
    name_by_id = {u["id"]: (u.get("name") or u.get("email") or "—") for u in res.data}
    for d in docs:
        if d.get("created_by"):
            d["created_by_name"] = name_by_id.get(d["created_by"], "—")
    return docs


@api.get("/athletes/{aid}/evaluations")
async def list_evaluations(aid: str, _: dict = Depends(get_current_user)):
    res = await db_call(lambda: sb.table("evaluations").select("*").eq("athlete_id", aid).order("date").execute())
    return await _enrich_user_names(res.data)


@api.post("/athletes/{aid}/evaluations")
async def create_evaluation(aid: str, body: EvaluationIn, user: dict = Depends(require_editor)):
    ath_res = await db_call(lambda: sb.table("athletes").select("*").eq("id", aid).maybe_single().execute())
    athlete = ath_res.data if ath_res else None
    if not athlete:
        raise HTTPException(status_code=404, detail="Atleta não encontrado")
    ev = body.model_dump()
    ev["id"] = new_id()
    ev["athlete_id"] = aid
    ev["created_at"] = now_iso()
    ev["created_by"] = user["id"]
    ev["metrics"] = compute_all(ev, athlete)
    res = await db_call(lambda: sb.table("evaluations").insert(ev).execute())
    created = res.data[0]
    await _enrich_user_names([created])
    return created


@api.delete("/evaluations/{eid}")
async def delete_evaluation(eid: str, _: dict = Depends(require_editor)):
    await db_call(lambda: sb.table("evaluations").delete().eq("id", eid).execute())
    return {"ok": True}


@api.put("/evaluations/{eid}")
async def update_evaluation(eid: str, body: EvaluationIn, user: dict = Depends(require_editor)):
    """Edita uma avaliação existente. Recalcula automaticamente todas as métricas
    contra os dados atuais do atleta e atualiza o campo `updated_at` + `updated_by`."""
    existing_res = await db_call(lambda: sb.table("evaluations").select("*").eq("id", eid).maybe_single().execute())
    existing = existing_res.data if existing_res else None
    if not existing:
        raise HTTPException(status_code=404, detail="Avaliação não encontrada")
    ath_res = await db_call(lambda: sb.table("athletes").select("*").eq("id", existing["athlete_id"]).maybe_single().execute())
    athlete = ath_res.data if ath_res else None
    if not athlete:
        raise HTTPException(status_code=404, detail="Atleta não encontrado")
    upd = body.model_dump()
    upd["metrics"] = compute_all(upd, athlete)
    upd["updated_at"] = now_iso()
    upd["updated_by"] = user["id"]
    res = await db_call(lambda: sb.table("evaluations").update(upd).eq("id", eid).execute())
    ev = res.data[0]
    await _enrich_user_names([ev])
    return ev


@api.post("/preview-metrics")
async def preview_metrics(body: dict, _: dict = Depends(get_current_user)):
    """Cálculo rápido do lado do servidor (útil se cliente não quiser calcular).
    Body: {athlete: {...}, evaluation: {...}}
    """
    return compute_all(body.get("evaluation", {}), body.get("athlete", {}))


# ---------- Weighins ----------
@api.get("/athletes/{aid}/weighins")
async def list_weighins(aid: str, _: dict = Depends(get_current_user)):
    res = await db_call(lambda: sb.table("weighins").select("*").eq("athlete_id", aid).order("date").execute())
    return res.data


@api.post("/athletes/{aid}/weighins")
async def create_weighin(aid: str, body: WeighinIn, user: dict = Depends(require_editor)):
    doc = body.model_dump()
    doc["id"] = new_id()
    doc["athlete_id"] = aid
    doc["created_at"] = now_iso()
    doc["created_by"] = user["id"]
    res = await db_call(lambda: sb.table("weighins").insert(doc).execute())
    return res.data[0]


@api.delete("/weighins/{wid}")
async def delete_weighin(wid: str, _: dict = Depends(require_editor)):
    await db_call(lambda: sb.table("weighins").delete().eq("id", wid).execute())
    return {"ok": True}


@api.get("/weighins")
async def list_all_weighins(days: int = 60, _: dict = Depends(get_current_user)):
    """Devolve todas as pesagens recentes (últimos N dias) com nome do atleta."""
    from datetime import datetime, timedelta, timezone as tz
    cutoff = (datetime.now(tz.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    w_res = await db_call(lambda: sb.table("weighins").select("*").gte("date", cutoff).order("date", desc=True).execute())
    a_res = await db_call(lambda: sb.table("athletes").select("id,nome,posicao").execute())
    return {"athletes": a_res.data, "weighins": w_res.data}


@api.post("/weighins/import")
async def import_weighins(
    file: UploadFile = File(...),
    user: dict = Depends(require_editor),
):
    """Aceita 2 formatos:
       (A) Long: colunas Nome/Data/Peso (uma linha por pesagem)
       (B) Wide: primeira coluna 'Atleta'/'Nome', restantes colunas com datas como cabeçalho.
    Tenta detetar automaticamente com base nos cabeçalhos das folhas.
    """
    import io
    import pandas as pd
    from datetime import datetime as _dt
    content = await file.read()
    ext = (file.filename or "").lower().split(".")[-1]

    def _try_read(sheet=0):
        if ext in ("xlsx", "xls"):
            return pd.read_excel(io.BytesIO(content), sheet_name=sheet)
        return pd.read_csv(io.BytesIO(content))

    # Tenta várias folhas — cada uma pode ter o cabeçalho em linhas diferentes (linha 0, 1 ou 2)
    raw_sheets = []
    if ext in ("xlsx", "xls"):
        try:
            book = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None)
            raw_sheets = list(book.values())
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Não consegui ler o ficheiro: {e}")
    else:
        try:
            raw_sheets = [pd.read_csv(io.BytesIO(content), header=None)]
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Não consegui ler o ficheiro: {e}")

    def _find_header_row(raw_df):
        """Devolve o índice da linha que contém 'Nome' ou 'Atleta' (case-insensitive)."""
        for i in range(min(10, len(raw_df))):
            row = raw_df.iloc[i].astype(str).str.strip().str.lower()
            if row.isin(["nome", "atleta", "name"]).any():
                return i
        return None

    dfs = []
    for raw in raw_sheets:
        h = _find_header_row(raw)
        if h is None:
            continue
        headers = raw.iloc[h].tolist()
        body = raw.iloc[h + 1:].copy()
        body.columns = headers
        dfs.append(body)

    athletes_res = await db_call(lambda: sb.table("athletes").select("id,nome").execute())
    athletes = athletes_res.data
    name_to_id = {a["nome"].strip().lower(): a["id"] for a in athletes}
    # Índice auxiliar: primeiro-nome (token único) → id, apenas quando é único.
    # Permite fazer match de "Emerson" → "Emerson Santos", "Mateus" → "Mateus Andrade", etc.
    from collections import defaultdict as _dd
    _first = _dd(list)
    _last = _dd(list)
    for a in athletes:
        tokens = a["nome"].strip().lower().split()
        if tokens:
            _first[tokens[0]].append(a["id"])
            _last[tokens[-1]].append(a["id"])
    first_to_id = {k: v[0] for k, v in _first.items() if len(v) == 1}
    last_to_id = {k: v[0] for k, v in _last.items() if len(v) == 1}

    def _resolve_athlete(nome: str) -> str | None:
        """Match tolerante: (1) nome completo exato,
        (2) primeiro nome único, (3) 'X.Apelido' → primeiro nome começa por X + último nome único."""
        key = nome.strip().lower()
        if key in name_to_id:
            return name_to_id[key]
        tokens = key.split()
        if len(tokens) == 1 and tokens[0] in first_to_id:
            return first_to_id[tokens[0]]
        if "." in key:
            parts = [p.strip() for p in key.replace(".", " ").split() if p.strip()]
            if len(parts) == 2:
                initial, last = parts
                last_id = last_to_id.get(last)
                if last_id:
                    for a in athletes:
                        if a["id"] == last_id and a["nome"].strip().lower().startswith(initial):
                            return last_id
        return None

    to_upsert: dict[tuple[str, str], float] = {}
    skipped: list[str] = []

    def _parse_date(v) -> str | None:
        if v is None:
            return None
        if hasattr(v, "strftime"):
            return v.strftime("%Y-%m-%d")
        s = str(v).strip()
        if not s or s.lower() == "nan":
            return None
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d"):
            try:
                return _dt.strptime(s[:10], fmt).strftime("%Y-%m-%d")
            except Exception:
                pass
        return None

    def _add(nome: str, date_str: str, peso: float):
        """Valida e acumula em memória — a escrita na BD é feita uma única vez
        no fim, num único upsert em lote (evita milhares de pedidos de rede
        sequenciais, que em ficheiros grandes excediam o tempo limite da função)."""
        import math
        aid = _resolve_athlete(nome)
        if not aid:
            skipped.append(f"{nome}: atleta não existe")
            return
        try:
            peso_f = float(peso)
        except Exception:
            skipped.append(f"{nome} {date_str}: peso inválido ({peso})")
            return
        if peso_f is None or math.isnan(peso_f) or math.isinf(peso_f) or peso_f <= 0 or peso_f > 300:
            skipped.append(f"{nome} {date_str}: peso inválido ({peso})")
            return
        # última ocorrência do (atleta, data) vence — igual ao comportamento anterior
        to_upsert[(aid, date_str)] = round(peso_f, 2)

    processed_any = False
    for df in dfs:
        if df is None or df.empty:
            continue
        cols = {str(c).strip().lower(): c for c in df.columns}
        c_nome = next((cols[k] for k in ("nome", "atleta", "name") if k in cols), None)
        c_data = next((cols[k] for k in ("data", "date") if k in cols), None)
        c_peso = next((cols[k] for k in ("peso", "peso (kg)", "kg", "weight") if k in cols), None)

        # Formato LONG (Nome / Data / Peso)
        if c_nome and c_data and c_peso:
            processed_any = True
            for _, row in df.iterrows():
                try:
                    nome = str(row[c_nome]).strip()
                    if not nome or nome.lower() == "nan":
                        continue
                    date_str = _parse_date(row[c_data])
                    if not date_str:
                        continue
                    peso = float(row[c_peso])
                    _add(nome, date_str, peso)
                except Exception as e:
                    skipped.append(f"linha inválida: {e}")
            continue

        # Formato WIDE (Atleta | 10/07/2026 | 11/07/2026 | ...)
        if c_nome:
            date_cols = []
            for orig in df.columns:
                if orig == c_nome:
                    continue
                d = _parse_date(orig)
                if d:
                    date_cols.append((orig, d))
            if date_cols:
                processed_any = True
                for _, row in df.iterrows():
                    try:
                        nome = str(row[c_nome]).strip().lstrip("—- ").strip()
                        if not nome or nome.lower() == "nan":
                            continue
                        for orig, date_str in date_cols:
                            v = row[orig]
                            if v is None or (isinstance(v, float) and pd.isna(v)):
                                continue
                            try:
                                peso = float(str(v).replace(",", "."))
                            except Exception:
                                continue
                            _add(nome, date_str, peso)
                    except Exception as e:
                        skipped.append(f"linha inválida: {e}")

    if not processed_any:
        raise HTTPException(
            status_code=400,
            detail="Não encontrei um formato válido. Precisa de Nome/Data/Peso ou Atleta + colunas com datas.",
        )

    rows = [
        {
            # sem "id": deixa a BD gerar; assim uma atualização (mesmo
            # atleta+data já existente) não muda a chave primária da linha.
            "athlete_id": aid,
            "date": date_str,
            "peso_kg": peso_kg,
            "created_at": now_iso(),
            "created_by": user["id"],
            "imported": True,
        }
        for (aid, date_str), peso_kg in to_upsert.items()
    ]
    # Um único upsert em lote (substitui pesagens existentes no mesmo dia).
    # Evita milhares de pedidos sequenciais à BD para ficheiros grandes.
    if rows:
        for i in range(0, len(rows), 500):
            batch = rows[i:i + 500]
            await db_call(lambda batch=batch: sb.table("weighins").upsert(
                batch, on_conflict="athlete_id,date"
            ).execute())

    return {"created": len(rows), "skipped": skipped}


# ---------- Photos ----------
# Fotos são guardadas no Supabase Storage (bucket privado "photos"); a tabela
# `photos` guarda apenas metadata + o caminho no storage (`storage_path`).

PHOTO_LIST_COLUMNS = "id,athlete_id,evaluation_id,date,kind,content_type,size,is_deleted,created_at,created_by"


@api.get("/athletes/{aid}/photos")
async def list_photos(aid: str, _: dict = Depends(get_current_user)):
    res = await db_call(
        lambda: sb.table("photos").select(PHOTO_LIST_COLUMNS)
        .eq("athlete_id", aid).eq("is_deleted", False).order("date").execute()
    )
    return res.data


@api.post("/athletes/{aid}/photos")
async def upload_photo(
    aid: str,
    file: UploadFile = File(...),
    date: str = Form(...),
    kind: str = Form(...),  # frontal | perfil | costas | profile
    evaluation_id: Optional[str] = Form(None),
    user: dict = Depends(require_editor),
):
    if kind not in ("frontal", "perfil", "costas", "profile"):
        raise HTTPException(status_code=400, detail="Tipo de foto inválido")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Ficheiro vazio")
    # Limite de segurança: 10 MB por foto
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Foto demasiado grande (máx 10 MB)")
    ext = (file.filename or "").split(".")[-1].lower() or "jpg"
    if ext not in ("jpg", "jpeg", "png", "webp"):
        ext = "jpg"
    ctype = content_type_for(ext)
    photo_id = new_id()
    storage_path = f"{aid}/{photo_id}.{ext}"
    await db_call(lambda: sb.storage.from_(PHOTOS_BUCKET).upload(storage_path, data, {"content-type": ctype}))
    doc = {
        "id": photo_id,
        "athlete_id": aid,
        "evaluation_id": evaluation_id,
        "date": date,
        "kind": kind,
        "content_type": ctype,
        "size": len(data),
        "storage_path": storage_path,
        "is_deleted": False,
        "created_at": now_iso(),
        "created_by": user["id"],
    }
    res = await db_call(lambda: sb.table("photos").insert(doc).execute())
    created = dict(res.data[0])
    created.pop("storage_path", None)
    return created


@api.patch("/photos/{pid}")
async def update_photo(pid: str, body: dict, _: dict = Depends(require_editor)):
    upd = {}
    if "kind" in body:
        if body["kind"] not in ("frontal", "perfil", "costas", "profile"):
            raise HTTPException(status_code=400, detail="Tipo de foto inválido")
        upd["kind"] = body["kind"]
    if "evaluation_id" in body:
        upd["evaluation_id"] = body["evaluation_id"]
    if "date" in body:
        upd["date"] = body["date"]
    if not upd:
        return {"ok": True}
    res = await db_call(lambda: sb.table("photos").update(upd).eq("id", pid).execute())
    if not res.data:
        raise HTTPException(status_code=404, detail="Foto não encontrada")
    return {"ok": True}


@api.put("/photos/{pid}/replace")
async def replace_photo(pid: str, file: UploadFile = File(...), _: dict = Depends(require_editor)):
    res = await db_call(lambda: sb.table("photos").select("*").eq("id", pid).maybe_single().execute())
    doc = res.data if res else None
    if not doc:
        raise HTTPException(status_code=404, detail="Foto não encontrada")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Ficheiro vazio")
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Foto demasiado grande (máx 10 MB)")
    ext = (file.filename or "").split(".")[-1].lower() or "jpg"
    if ext not in ("jpg", "jpeg", "png", "webp"):
        ext = "jpg"
    ctype = content_type_for(ext)
    await db_call(lambda: sb.storage.from_(PHOTOS_BUCKET).upload(
        doc["storage_path"], data, {"content-type": ctype, "upsert": "true"}
    ))
    await db_call(lambda: sb.table("photos").update({
        "content_type": ctype,
        "size": len(data),
    }).eq("id", pid).execute())
    return {"ok": True}


async def _load_photo_bytes(doc: dict) -> tuple[bytes, str]:
    ctype = doc.get("content_type") or "image/jpeg"
    data = await db_call(lambda: sb.storage.from_(PHOTOS_BUCKET).download(doc["storage_path"]))
    return data, ctype


@api.get("/photos/{pid}/download")
async def download_photo(pid: str, request: Request, auth: Optional[str] = Query(None)):
    # Manual auth (suporta cookie ou token via ?auth= para <img src>)
    token = request.cookies.get("access_token") or auth
    if not token:
        h = request.headers.get("Authorization", "")
        if h.startswith("Bearer "):
            token = h[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Não autenticado")
    try:
        jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except Exception:
        raise HTTPException(status_code=401, detail="Token inválido")
    res = await db_call(lambda: sb.table("photos").select("*").eq("id", pid).eq("is_deleted", False).maybe_single().execute())
    doc = res.data if res else None
    if not doc:
        raise HTTPException(status_code=404, detail="Foto não encontrada")
    try:
        data, ctype = await _load_photo_bytes(doc)
    except Exception as e:
        logger.error("Falha ao carregar foto %s: %s", pid, e)
        raise HTTPException(status_code=502, detail="Não foi possível carregar a foto")
    return FastAPIResponse(content=data, media_type=ctype)


@api.delete("/photos/{pid}")
async def delete_photo(pid: str, _: dict = Depends(require_editor)):
    await db_call(lambda: sb.table("photos").update({"is_deleted": True}).eq("id", pid).execute())
    return {"ok": True}


# ---------- Templates (ex: modelo Excel de pesagens) ----------
TEMPLATES_BUCKET = "templates"
PESAGENS_TEMPLATE_PATH = "pesagens-modelo.xlsx"
XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@api.get("/templates/pesagens")
async def download_pesagens_template(_: dict = Depends(get_current_user)):
    try:
        data = await db_call(lambda: sb.storage.from_(TEMPLATES_BUCKET).download(PESAGENS_TEMPLATE_PATH))
    except Exception:
        raise HTTPException(status_code=404, detail="Ainda não foi enviado nenhum modelo. Peça a um editor para o enviar.")
    return FastAPIResponse(
        content=data,
        media_type=XLSX_CONTENT_TYPE,
        headers={"Content-Disposition": 'attachment; filename="Trofense_Modelo_Pesagens.xlsx"'},
    )


@api.post("/templates/pesagens")
async def upload_pesagens_template(file: UploadFile = File(...), _: dict = Depends(require_editor)):
    ext = (file.filename or "").lower().split(".")[-1]
    if ext not in ("xlsx", "xls"):
        raise HTTPException(status_code=400, detail="O modelo tem de ser um ficheiro .xlsx ou .xls")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Ficheiro vazio")
    await db_call(lambda: sb.storage.from_(TEMPLATES_BUCKET).upload(
        PESAGENS_TEMPLATE_PATH, data, {"content-type": XLSX_CONTENT_TYPE, "upsert": "true"}
    ))
    return {"ok": True}


# ---------- Backup / Restore ----------
@api.get("/backup/export")
async def backup_export(_: dict = Depends(require_editor)):
    """Backup completo com fotos em base64 (para restore noutro ambiente)."""
    athletes_res = await db_call(lambda: sb.table("athletes").select("*").execute())
    evaluations_res = await db_call(lambda: sb.table("evaluations").select("*").execute())
    weighins_res = await db_call(lambda: sb.table("weighins").select("*").execute())
    photos_res = await db_call(lambda: sb.table("photos").select("*").eq("is_deleted", False).execute())

    photos = []
    for p in photos_res.data:
        p = dict(p)
        storage_path = p.pop("storage_path", None)
        try:
            data = await db_call(lambda sp=storage_path: sb.storage.from_(PHOTOS_BUCKET).download(sp))
            p["data_base64"] = base64.b64encode(data).decode("ascii")
        except Exception as e:
            logger.warning("Backup: falha ao ler foto %s do storage: %s", p.get("id"), e)
            p["data_base64"] = None
        photos.append(p)

    return {
        "version": 1,
        "exported_at": now_iso(),
        "athletes": athletes_res.data,
        "evaluations": evaluations_res.data,
        "weighins": weighins_res.data,
        "photos": photos,
    }


@api.post("/backup/import")
async def backup_import(body: dict, user: dict = Depends(require_editor)):
    """Restaura backup JSON com estratégia MERGE:
    - Atletas: match por nome (case-insensitive). Se existe, mantém o atual e reutiliza
      o id; se não existe, insere com o id do JSON.
    - Avaliações: match por (athlete_id, date) — ignora duplicados.
    - Pesagens: match por (athlete_id, date) — ignora duplicados.
    - Fotos: match por (athlete_id, date, kind) — ignora duplicados. Requer `data_base64`
      (o backup é reenviado para o Supabase Storage).
    Devolve contagens do que foi inserido e ignorado.
    """
    stats = {
        "athletes": {"inserted": 0, "matched": 0},
        "evaluations": {"inserted": 0, "skipped": 0},
        "weighins": {"inserted": 0, "skipped": 0},
        "photos": {"inserted": 0, "skipped": 0, "no_data": 0},
        "errors": [],
    }

    existing_res = await db_call(lambda: sb.table("athletes").select("id,nome").execute())

    def _norm_name(s: str) -> str:
        return " ".join((s or "").strip().split()).lower()
    existing_by_name: dict[str, str] = {_norm_name(a["nome"]): a["id"] for a in existing_res.data}

    id_map: dict[str, str] = {}
    incoming_athletes = body.get("athletes") or []
    for a in incoming_athletes:
        try:
            name = (a.get("nome") or "").strip()
            if not name:
                stats["errors"].append("atleta sem nome")
                continue
            key = _norm_name(name)
            existing_id = existing_by_name.get(key)
            if existing_id:
                id_map[a.get("id", "")] = existing_id
                stats["athletes"]["matched"] += 1
                continue
            new_a = {k: v for k, v in a.items() if k not in ("id", "created_at", "created_by")}
            new_a["id"] = new_id()
            new_a["created_at"] = now_iso()
            new_a["created_by"] = user["id"]
            await db_call(lambda new_a=new_a: sb.table("athletes").insert(new_a).execute())
            id_map[a.get("id", "")] = new_a["id"]
            existing_by_name[key] = new_a["id"]
            stats["athletes"]["inserted"] += 1
        except Exception as e:
            stats["errors"].append(f"atleta {a.get('nome','?')}: {e}")

    def _resolve_aid(old_aid: str) -> str | None:
        return id_map.get(old_aid) or (old_aid if old_aid else None)

    # 2) Avaliações — merge por (athlete_id, date)
    athletes_cache: dict[str, dict] = {}
    for ev in body.get("evaluations") or []:
        try:
            aid = _resolve_aid(ev.get("athlete_id", ""))
            if not aid:
                continue
            date = ev.get("date")
            if not date:
                continue
            existing = await db_call(
                lambda aid=aid, date=date: sb.table("evaluations").select("id")
                .eq("athlete_id", aid).eq("date", date).maybe_single().execute()
            )
            if existing and existing.data:
                stats["evaluations"]["skipped"] += 1
                continue
            doc = {k: v for k, v in ev.items() if k not in ("id", "created_at", "created_by")}
            doc["athlete_id"] = aid
            doc["id"] = new_id()
            doc["created_at"] = now_iso()
            doc["created_by"] = user["id"]
            if aid not in athletes_cache:
                ath_res = await db_call(lambda aid=aid: sb.table("athletes").select("*").eq("id", aid).maybe_single().execute())
                athletes_cache[aid] = ath_res.data if ath_res else None
            ath = athletes_cache[aid]
            if ath:
                doc["metrics"] = compute_all(doc, ath)
            await db_call(lambda doc=doc: sb.table("evaluations").insert(doc).execute())
            stats["evaluations"]["inserted"] += 1
        except Exception as e:
            stats["errors"].append(f"avaliação {ev.get('date','?')}: {e}")

    # 3) Pesagens — merge por (athlete_id, date)
    for w in body.get("weighins") or []:
        try:
            aid = _resolve_aid(w.get("athlete_id", ""))
            if not aid or not w.get("date") or w.get("peso_kg") is None:
                continue
            existing = await db_call(
                lambda aid=aid, date=w["date"]: sb.table("weighins").select("id")
                .eq("athlete_id", aid).eq("date", date).maybe_single().execute()
            )
            if existing and existing.data:
                stats["weighins"]["skipped"] += 1
                continue
            doc = {k: v for k, v in w.items() if k not in ("id", "created_at", "created_by")}
            doc["athlete_id"] = aid
            doc["id"] = new_id()
            doc["created_at"] = now_iso()
            doc["created_by"] = user["id"]
            await db_call(lambda doc=doc: sb.table("weighins").insert(doc).execute())
            stats["weighins"]["inserted"] += 1
        except Exception as e:
            stats["errors"].append(f"pesagem {w.get('date','?')}: {e}")

    # 4) Fotos — merge por (athlete_id, date, kind)
    for p in body.get("photos") or []:
        try:
            aid = _resolve_aid(p.get("athlete_id", ""))
            if not aid or not p.get("date") or not p.get("kind"):
                continue
            existing = await db_call(
                lambda aid=aid, date=p["date"], kind=p["kind"]: sb.table("photos").select("id")
                .eq("athlete_id", aid).eq("date", date).eq("kind", kind).eq("is_deleted", False)
                .maybe_single().execute()
            )
            if existing and existing.data:
                stats["photos"]["skipped"] += 1
                continue
            b64 = p.get("data_base64")
            if not b64:
                stats["photos"]["no_data"] += 1
                continue
            raw = base64.b64decode(b64)
            ctype = p.get("content_type") or "image/jpeg"
            ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(ctype, "jpg")
            photo_id = new_id()
            storage_path = f"{aid}/{photo_id}.{ext}"
            await db_call(lambda: sb.storage.from_(PHOTOS_BUCKET).upload(storage_path, raw, {"content-type": ctype}))
            doc = {
                "id": photo_id,
                "athlete_id": aid,
                "evaluation_id": None,
                "date": p["date"],
                "kind": p["kind"],
                "content_type": ctype,
                "size": len(raw),
                "storage_path": storage_path,
                "is_deleted": False,
                "created_at": now_iso(),
                "created_by": user["id"],
            }
            await db_call(lambda doc=doc: sb.table("photos").insert(doc).execute())
            stats["photos"]["inserted"] += 1
        except Exception as e:
            stats["errors"].append(f"foto {p.get('date','?')}/{p.get('kind','?')}: {e}")

    return stats


# ---------- Monthly report ----------
@api.get("/reports/monthly")
async def monthly_report(month_a: str, month_b: str, _: dict = Depends(get_current_user)):
    """Compara a ÚLTIMA avaliação do mês A com a última do mês B.
    Devolve para cada atleta: altura, peso, %MG (Reilly), IMC, Σ8 pregas,
    massa muscular (Lee) e perímetro médio da coxa (PMC = média de coxaD/E).
    """
    res = await db_call(lambda: sb.table("athletes").select("*").order("nome").execute())
    athletes = res.data
    rows = []
    for a in athletes:
        snap_a = await _month_snapshot(a["id"], month_a)
        snap_b = await _month_snapshot(a["id"], month_b)
        rows.append({
            "athlete_id": a["id"],
            "nome": a["nome"],
            "sexo": a["sexo"],
            "posicao": a.get("posicao"),
            "altura_cm": a.get("altura_cm"),
            "month_a": snap_a,
            "month_b": snap_b,
            "delta": {
                "peso": _delta(snap_a.get("peso"), snap_b.get("peso")),
                "bf": _delta(snap_a.get("bf"), snap_b.get("bf")),
                "imc": _delta(snap_a.get("imc"), snap_b.get("imc")),
                "soma8": _delta(snap_a.get("soma8"), snap_b.get("soma8")),
                "muscle_mass_kg": _delta(snap_a.get("muscle_mass_kg"), snap_b.get("muscle_mass_kg")),
                "pmc": _delta(snap_a.get("pmc"), snap_b.get("pmc")),
            },
        })
    return {"month_a": month_a, "month_b": month_b, "rows": rows}


def _delta(a: Any, b: Any):
    if a is None or b is None:
        return None
    return round(b - a, 2)


def _month_bounds(month: str) -> tuple[str, str]:
    """('2026-07-01', '2026-08-01')"""
    start = f"{month}-01"
    y, m = map(int, month.split("-"))
    m += 1
    if m > 12:
        m = 1; y += 1
    end = f"{y:04d}-{m:02d}-01"
    return start, end


async def _month_snapshot(aid: str, month: str) -> dict:
    """Devolve a última avaliação do mês (ou null se não houver). Todos os
    valores vêm exclusivamente da avaliação para garantir coerência entre
    peso, %MG, IMC, Massa Muscular e perímetros."""
    start, end = _month_bounds(month)
    res = await db_call(
        lambda: sb.table("evaluations").select("*")
        .eq("athlete_id", aid).gte("date", start).lt("date", end)
        .order("date", desc=True).limit(1).execute()
    )
    ev = res.data[0] if res.data else None
    m = (ev or {}).get("metrics", {}) if ev else {}
    perims = (ev or {}).get("perimetros", {}) if ev else {}
    coxaD = perims.get("coxaD")
    coxaE = perims.get("coxaE")
    pmc = None
    if coxaD is not None and coxaE is not None:
        pmc = round((float(coxaD) + float(coxaE)) / 2, 1)
    elif coxaD is not None:
        pmc = float(coxaD)
    elif coxaE is not None:
        pmc = float(coxaE)
    peso = ev.get("peso_kg") if ev else None
    return {
        "date": ev.get("date") if ev else None,
        "peso": peso,
        "bf": m.get("rw"),
        "imc": m.get("imc"),
        "soma8": round(m["soma8"], 1) if m.get("soma8") is not None else None,
        "muscle_mass_kg": m.get("muscle_mass_kg"),
        "pmc": pmc,
        "has_eval": ev is not None,
    }


# ---------- Startup ----------
@app.on_event("startup")
async def startup():
    # Seed admin (editor)
    admin_email = os.environ["ADMIN_EMAIL"].lower()
    admin_pwd = os.environ["ADMIN_PASSWORD"]
    res = await db_call(lambda: sb.table("users").select("*").eq("email", admin_email).maybe_single().execute())
    existing = res.data if res else None
    if not existing:
        await db_call(lambda: sb.table("users").insert({
            "id": new_id(),
            "email": admin_email,
            "name": "Admin CD Trofense",
            "role": "editor",
            "active": True,
            "password_hash": hash_password(admin_pwd),
            "created_at": now_iso(),
        }).execute())
        logger.info("Admin seeded: %s", admin_email)
    elif not verify_password(admin_pwd, existing["password_hash"]):
        await db_call(lambda: sb.table("users").update(
            {"password_hash": hash_password(admin_pwd), "active": True}
        ).eq("email", admin_email).execute())
        logger.info("Admin password refreshed for %s", admin_email)


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
