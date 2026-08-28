import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { computeGoalStatus } from "@/lib/goalStatus";
import { rwBand, soma8Band, percMMBand, mmMgBand, imcBand } from "@/lib/formulas";
import logoUrl from "@/assets/cdt-logo-small.png";

// Cores institucionais do CD Trofense (RGB) — sincronizadas com index.css.
const CLUB_RED = [220, 25, 40];
const CLUB_NAVY = [27, 44, 90];
const CLUB_YELLOW = [255, 210, 0];

// Cache do emblema como data URL (evita recarregar em cada exportação).
let _logoDataUrl = null;
async function getLogoDataUrl() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    const res = await fetch(logoUrl);
    const blob = await res.blob();
    _logoDataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch (e) {
    _logoDataUrl = null;
  }
  return _logoDataUrl;
}

/** Cabeçalho comum em todas as páginas do PDF (com emblema oficial).
 *  Design: faixa navy sólida + linha fina vermelha + linha fina amarela como accent
 *  (o navy é a cor institucional predominante da app; vermelho e amarelo funcionam como acentos).
 */
function drawHeader(doc, subtitle, logoData) {
  const pageW = doc.internal.pageSize.getWidth();
  // Faixa navy sólida (cor principal do cabeçalho)
  doc.setFillColor(...CLUB_NAVY);
  doc.rect(0, 0, pageW, 24, "F");
  // Linha vermelha fina (accent)
  doc.setFillColor(...CLUB_RED);
  doc.rect(0, 24, pageW, 1.2, "F");
  // Linha amarela ultra-fina abaixo (assinatura visual do clube)
  doc.setFillColor(...CLUB_YELLOW);
  doc.rect(0, 25.2, pageW, 0.6, "F");

  // Emblema no canto (se disponível)
  if (logoData) {
    try { doc.addImage(logoData, "PNG", 10, 4, 16, 16); } catch { /* ignore */ }
  }
  // Título
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("CLUBE DESPORTIVO TROFENSE", 30, 11);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text("Departamento Médico · Composição Corporal", 30, 17);
  // Data topo direito
  doc.setFontSize(8);
  const now = new Date().toLocaleString("pt-PT", { dateStyle: "long", timeStyle: "short" });
  doc.text(now, pageW - 10, 13, { align: "right" });

  // Subtítulo (fora da faixa, com respiração)
  doc.setTextColor(...CLUB_NAVY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(subtitle, 14, 38);
}

/** Rodapé com paginação + assinatura do clube. Fino e discreto. */
function drawFooter(doc) {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    // pageH deve ser lido POR PÁGINA porque algumas podem ser landscape (fotos)
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    // Linha navy suave no rodapé
    doc.setDrawColor(...CLUB_NAVY);
    doc.setLineWidth(0.3);
    doc.line(14, pageH - 12, pageW - 14, pageH - 12);
    doc.setFontSize(7.5);
    doc.setTextColor(140);
    doc.setFont("helvetica", "italic");
    doc.text("Desde 1930 · história, paixão e glória", 14, pageH - 6);
    doc.setFont("helvetica", "normal");
    doc.text(`Página ${i} de ${pages}`, pageW - 14, pageH - 6, { align: "right" });
  }
}

/** Traduz uma cor de banda para RGB usado nas células. */
function bandRgb(color) {
  switch (color) {
    case "otimo": return [16, 185, 129];      // emerald
    case "atencao": return [245, 158, 11];    // amber
    case "alto": return [239, 68, 68];        // red
    default: return [100, 116, 139];          // slate
  }
}

function statusRgb(status) {
  switch (status) {
    case "atingido": return [16, 185, 129];
    case "quase_la": return [132, 204, 22];
    case "em_progresso": return [245, 158, 11];
    case "prioritario": return [239, 68, 68];
    default: return [100, 116, 139];
  }
}

/** PDF do Dashboard: KPIs + Plantel completo por atleta. */
export async function exportDashboardPdf(athletes, stats) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const logo = await getLogoDataUrl();
  drawHeader(doc, "Dashboard · Plantel", logo);

  // KPIs em linha
  const kpis = [
    ["Atletas", String(stats?.total ?? "—")],
    ["Peso médio", stats?.avgPeso ? `${stats.avgPeso} kg` : "—"],
    ["% MG média (R&W)", stats?.avgBf ? `${stats.avgBf}%` : "—"],
    ["Em Ótimo (<9%)", String(stats?.otimo ?? "—")],
    ["Atenção / Alto", stats ? `${stats.atencao} / ${stats.alto}` : "—"],
  ];
  autoTable(doc, {
    startY: 44,
    theme: "plain",
    head: [kpis.map((k) => k[0])],
    body: [kpis.map((k) => k[1])],
    styles: { halign: "center", fontSize: 8, cellPadding: 3, lineColor: [230, 230, 230], lineWidth: 0.1 },
    headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 7.5, cellPadding: 2.5 },
    bodyStyles: { fontStyle: "bold", fontSize: 13, textColor: CLUB_NAVY, cellPadding: 4 },
  });

  // Tabela do plantel — cabeçalho navy, respiração generosa, alternância suave
  const head = [["Nome", "Posição", "Idade", "Alt. (cm)", "Peso (kg)", "% MG (R&W)", "Soma 8 (mm)", "% MM", "MM/MG", "IMC"]];
  const body = athletes.map((a) => {
    const m = a.last_metrics || {};
    return [
      a.nome,
      a.posicao || "—",
      a.idade != null ? String(a.idade) : "—",
      a.altura_cm != null ? String(a.altura_cm) : "—",
      a.display_weight != null ? String(a.display_weight) : "—",
      { content: m.rw != null ? `${m.rw}%` : "—", band: rwBand(m.rw).color },
      { content: m.soma8 != null ? `${Math.round(m.soma8)} mm` : "—", band: soma8Band(m.soma8).color },
      { content: m.perc_mm != null ? `${m.perc_mm}%` : "—", band: percMMBand(m.perc_mm).color },
      { content: m.mm_mg_ratio != null ? String(m.mm_mg_ratio) : "—", band: mmMgBand(m.mm_mg_ratio, a.sexo === "M" ? 1 : 0).color },
      { content: m.imc != null ? String(m.imc) : "—", band: imcBand(m.imc).color },
    ];
  });

  autoTable(doc, {
    head,
    body,
    startY: doc.lastAutoTable.finalY + 8,
    theme: "plain",
    styles: { fontSize: 9, cellPadding: 3, lineColor: [235, 235, 235], lineWidth: 0.15 },
    headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 8.5, cellPadding: 3 },
    alternateRowStyles: { fillColor: [248, 249, 251] },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 45, textColor: CLUB_NAVY },
      2: { halign: "center" },
      3: { halign: "center" },
      4: { halign: "center" },
      5: { halign: "center" },
      6: { halign: "center" },
      7: { halign: "center" },
      8: { halign: "center" },
      9: { halign: "center" },
    },
    // Colorir células com base na banda (só o texto — evita blocos de cor)
    didParseCell: (data) => {
      const cell = data.cell.raw;
      if (data.section === "body" && cell && typeof cell === "object" && cell.band) {
        const [r, g, b] = bandRgb(cell.band);
        data.cell.styles.textColor = [r, g, b];
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  drawFooter(doc);
  const filename = `trofense_dashboard_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}

/** PDF dos Objetivos de Equipa: réplica da tabela do ecrã (sem sumário separado). */
export async function exportTeamGoalsPdf(rows, counts) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const logo = await getLogoDataUrl();
  drawHeader(doc, "Objetivos de Equipa · Ajustes de peso", logo);

  const pageW = doc.internal.pageSize.getWidth();

  // Tabela — mesmas colunas que aparecem no ecrã da app (símbolos Σ/Δ substituídos por texto por incompatibilidade da fonte Helvetica)
  const head = [["Atleta", "Posição", "Estado", "Peso atual", "% MG atual", "Alvo", "Peso alvo", "Dif. peso", "Direção"]];
  const body = rows.map((r) => [
    r.nome,
    r.posicao || "—",
    { content: r.label, status: r.status },
    r.currentWeight != null ? `${r.currentWeight} kg` : "—",
    r.currentBf != null ? `${r.currentBf}%` : "—",
    r.primary === "imc" && r.targetImc != null
      ? `IMC ${r.targetImc}`
      : r.targetBf != null ? `${r.targetBf}% MG` : "—",
    r.targetWeight != null ? `${r.targetWeight} kg` : "—",
    r.absDelta != null ? `${r.absDelta} kg` : "—",
    r.direction === "perder" ? "A perder peso" : r.direction === "ganhar" ? "A ganhar peso" : r.direction === "manter" ? "No alvo" : "—",
  ]);

  autoTable(doc, {
    head,
    body,
    startY: 44,
    theme: "plain",
    styles: { fontSize: 9, cellPadding: 3, lineColor: [235, 235, 235], lineWidth: 0.15 },
    headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 8.5, cellPadding: 3 },
    alternateRowStyles: { fillColor: [248, 249, 251] },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 48, textColor: CLUB_NAVY },
      1: { cellWidth: 22 },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right", fontStyle: "bold" },
      8: { halign: "center" },
    },
    didParseCell: (data) => {
      const cell = data.cell.raw;
      if (data.section === "body" && cell && typeof cell === "object" && cell.status) {
        const [r, g, b] = statusRgb(cell.status);
        data.cell.styles.textColor = [r, g, b];
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  // Nota final compacta com faixas
  const finalY = doc.lastAutoTable.finalY + 8;
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text(
    "Faixas: Atingido ≤0.5 kg · Quase lá ≤2 kg · Em progresso ≤5 kg · Prioritário >5 kg. " +
    "Peso alvo calculado a partir do peso atual, % MG atual (Reilly & Wallace) e % MG alvo, preservando a massa magra.",
    14, finalY, { maxWidth: pageW - 28 }
  );

  drawFooter(doc);
  const filename = `trofense_objetivos_equipa_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}

// -------------------------------------------------------------------
// PDF INDIVIDUAL POR ATLETA
// -------------------------------------------------------------------

/** Descarrega uma foto autenticada e devolve como data URL (para embed em PDF).
 *  Aplica automaticamente a rotação EXIF ('from-image') via createImageBitmap para que
 *  as fotos apareçam com a orientação correta (o jsPDF não respeita o flag EXIF).
 */
async function fetchPhotoAsDataUrl(photoId) {
  try {
    const token = localStorage.getItem("trofense_token");
    const base = process.env.REACT_APP_BACKEND_URL || "";
    const res = await fetch(`${base}/api/photos/${photoId}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await normalizeToDataUrl(blob);
  } catch { return null; }
}

/** Descodifica o blob respeitando a orientação EXIF e devolve um dataURL JPEG normalizado. */
async function normalizeToDataUrl(blob) {
  // Tenta primeiro com createImageBitmap (respeita EXIF nativamente em navegadores modernos).
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    // Fallback: devolve o data URL raw (sem correção EXIF)
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
}

/** Devolve {w, h} naturais de uma imagem a partir de um data URL. */
async function getImageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = dataUrl;
  });
}

/** Ajusta a imagem à caixa (contain), preservando aspect ratio. Devolve x/y/w/h para o addImage. */
function fitContain(imgW, imgH, boxX, boxY, boxW, boxH) {
  if (!imgW || !imgH) return { x: boxX, y: boxY, w: boxW, h: boxH };
  const boxAspect = boxW / boxH;
  const imgAspect = imgW / imgH;
  let w, h;
  if (imgAspect > boxAspect) {
    // limitado pela largura
    w = boxW;
    h = boxW / imgAspect;
  } else {
    // limitado pela altura
    h = boxH;
    w = boxH * imgAspect;
  }
  const x = boxX + (boxW - w) / 2;
  const y = boxY + (boxH - h) / 2;
  return { x, y, w, h };
}

/** Desenha um gráfico de linhas simples de evolução de uma métrica. */
function drawLineChart(doc, title, points, x, y, w, h, unit = "") {
  const nav = CLUB_NAVY;
  const red = CLUB_RED;
  // Título
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...nav);
  doc.text(title, x, y - 2);
  if (!points || points.length < 2) {
    doc.setDrawColor(200);
    doc.setLineWidth(0.2);
    doc.rect(x, y, w, h);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text("Dados insuficientes", x + w / 2, y + h / 2, { align: "center" });
    return;
  }
  // Layout: axisW à esquerda para labels Y, chart à direita
  const axisW = 12;
  const chartX = x + axisW;
  const chartW = w - axisW;

  // Frame só do plot area
  doc.setDrawColor(200);
  doc.setLineWidth(0.2);
  doc.rect(chartX, y, chartW, h);

  // Domínio Y com padding proporcional (nunca abaixo de 0 para métricas +ve)
  const values = points.map((p) => p.v);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin;
  const desiredSpan = Math.max(span * 1.3, Math.max(1, rawMax * 0.05));
  const center = (rawMin + rawMax) / 2;
  let yMin = center - desiredSpan / 2;
  let yMax = center + desiredSpan / 2;
  if (yMin < 0 && rawMin >= 0) { yMax += -yMin; yMin = 0; }
  const range = yMax - yMin || 1;

  const padX = 3;
  const innerW = chartW - padX * 2;
  const innerH = h;

  // Gridlines Y + labels (4 divisões)
  doc.setFontSize(6.5);
  doc.setTextColor(120);
  const divisions = 4;
  for (let i = 0; i <= divisions; i++) {
    const yy = y + (innerH * i) / divisions;
    const val = yMax - (range * i) / divisions;
    if (i > 0 && i < divisions) {
      doc.setDrawColor(235);
      doc.line(chartX, yy, chartX + chartW, yy);
    }
    // label à esquerda alinhado ao eixo, com fallback para inteiros
    const formatted = Math.abs(val) >= 100 ? val.toFixed(0) : val.toFixed(1);
    doc.text(`${formatted}${unit}`, chartX - 1.5, yy + 1, { align: "right" });
  }

  // Linha do gráfico
  doc.setDrawColor(...red);
  doc.setLineWidth(0.6);
  const step = points.length === 1 ? 0 : innerW / (points.length - 1);
  let prev = null;
  const coords = points.map((p, i) => {
    const px = chartX + padX + step * i;
    const py = y + innerH - ((p.v - yMin) / range) * innerH;
    return [px, py];
  });
  coords.forEach(([px, py], i) => {
    if (prev) doc.line(prev[0], prev[1], px, py);
    prev = [px, py];
  });
  // Pontos
  doc.setFillColor(...red);
  coords.forEach(([px, py]) => doc.circle(px, py, 0.9, "F"));

  // Rótulos X — primeiro e último, DENTRO da margem inferior de 4mm
  doc.setFontSize(6.5);
  doc.setTextColor(120);
  const xLabelY = y + h + 3;
  doc.text(points[0].d, chartX + padX, xLabelY);
  if (points.length > 1) {
    doc.text(points[points.length - 1].d, chartX + chartW - padX, xLabelY, { align: "right" });
  }
}

/**
 * PDF individual por atleta: capa com foto de perfil + KPIs + histórico + evolução.
 * `athlete`, `evals` (ordenados asc), `weighins` (ordenados asc).
 * Se `saveFile=false`, devolve o `doc` sem gravar (útil para envio por email).
 */
export async function exportAthletePdf(athlete, evals, weighins, saveFile = true) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const logo = await getLogoDataUrl();
  drawHeader(doc, `Relatório · ${athlete.nome}`, logo);

  const pageW = doc.internal.pageSize.getWidth();

  // Descarregar foto de perfil se existir
  let profileDataUrl = null;
  try {
    const token = localStorage.getItem("trofense_token");
    const base = process.env.REACT_APP_BACKEND_URL || "";
    const listRes = await fetch(`${base}/api/athletes/${athlete.id}/photos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (listRes.ok) {
      const list = await listRes.json();
      const prof = (list || []).find((p) => p.kind === "profile");
      if (prof) profileDataUrl = await fetchPhotoAsDataUrl(prof.id);
    }
  } catch { /* ignore */ }

  // Bloco identificação: avatar + dados
  const cardY = 46;
  const cardH = 46;
  // Rectângulo com borda subtil e canto superior esquerdo com acento vermelho
  doc.setDrawColor(230);
  doc.setLineWidth(0.3);
  doc.rect(14, cardY, pageW - 28, cardH);
  doc.setFillColor(...CLUB_RED);
  doc.rect(14, cardY, 3, cardH, "F"); // barra vermelha vertical à esquerda
  // Avatar (com anel navy)
  const avX = 22, avY = cardY + 4, avSize = 38;
  if (profileDataUrl) {
    try {
      const s = await getImageSize(profileDataUrl);
      const fit = fitContain(s.w, s.h, avX, avY, avSize, avSize);
      // Fundo cinza claro para preencher zonas laterais quando aspect ≠ 1:1
      doc.setFillColor(230, 232, 236);
      doc.rect(avX, avY, avSize, avSize, "F");
      doc.addImage(profileDataUrl, "JPEG", fit.x, fit.y, fit.w, fit.h);
    } catch { /* ignore */ }
  } else {
    doc.setFillColor(230, 232, 236);
    doc.rect(avX, avY, avSize, avSize, "F");
    doc.setTextColor(...CLUB_NAVY);
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    const initials = (athlete.nome || "").split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
    doc.text(initials || "?", avX + avSize / 2, avY + avSize / 2 + 3, { align: "center" });
  }
  // Dados à direita do avatar
  const infoX = avX + avSize + 8;
  doc.setTextColor(...CLUB_NAVY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text(athlete.nome || "—", infoX, cardY + 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  const meta = [
    athlete.posicao || null,
    athlete.sexo === "M" ? "Masculino" : "Feminino",
    athlete.idade != null ? `${athlete.idade} anos` : null,
    athlete.altura_cm != null ? `${athlete.altura_cm} cm` : null,
    athlete.etnia ? athlete.etnia : null,
  ].filter(Boolean).join("  ·  ");
  doc.text(meta, infoX, cardY + 21);

  const last = evals[evals.length - 1];
  const first = evals[0];
  if (last) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...CLUB_RED);
    doc.text("ÚLTIMA AVALIAÇÃO", infoX, cardY + 32);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(60);
    doc.text(new Date(last.date).toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" }), infoX, cardY + 38);
  }

  // Título da secção KPIs
  const kpiY = cardY + cardH + 10;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...CLUB_NAVY);
  doc.text("INDICADORES · Última avaliação", 14, kpiY - 3);
  doc.setDrawColor(...CLUB_NAVY);
  doc.setLineWidth(0.4);
  doc.line(14, kpiY - 1.5, 70, kpiY - 1.5);
  // KPIs (grelha 4x2 abaixo)
  const kpis = last ? [
    ["Peso", `${last.peso_kg} kg`],
    ["% MG (R&W)", `${last.metrics?.rw ?? "—"}%`],
    ["Massa Gorda", `${last.metrics?.fat_mass_kg ?? "—"} kg`],
    ["Massa Magra", `${last.metrics?.lean_mass_kg ?? "—"} kg`],
    ["Massa Muscular", `${last.metrics?.muscle_mass_kg ?? "—"} kg`],
    ["MM/MG", `${last.metrics?.mm_mg_ratio ?? "—"}`],
    ["IMC", `${last.metrics?.imc ?? "—"}`],
    ["Soma 8 pregas", `${last.metrics?.soma8 != null ? `${Math.round(last.metrics.soma8)} mm` : "—"}`],
  ] : [];
  if (kpis.length) {
    autoTable(doc, {
      startY: kpiY,
      theme: "plain",
      head: [kpis.map((k) => k[0])],
      body: [kpis.map((k) => k[1])],
      styles: { halign: "center", fontSize: 7.5, cellPadding: 3, lineColor: [235, 235, 235], lineWidth: 0.15 },
      headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 7, cellPadding: 2 },
      bodyStyles: { fontStyle: "bold", fontSize: 11, cellPadding: 4, textColor: CLUB_NAVY },
      margin: { left: 14, right: 14 },
    });
  }

  // Título da secção métodos
  const methY = (doc.lastAutoTable?.finalY ?? kpiY) + 10;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...CLUB_NAVY);
  doc.text("MÉTODOS DE CÁLCULO · % Massa Gorda", 14, methY - 3);
  doc.setDrawColor(...CLUB_NAVY);
  doc.line(14, methY - 1.5, 80, methY - 1.5);
  // Comparativo entre métodos
  if (last?.metrics) {
    autoTable(doc, {
      startY: methY,
      theme: "plain",
      head: [["Reilly & Wallace", "Jackson-Pollock 7", "Evans 7", "Evans 3", "Withers"]],
      body: [[
        `${last.metrics.rw ?? "—"}%`,
        `${last.metrics.jp7 ?? "—"}%`,
        `${last.metrics.evans7 ?? "—"}%`,
        `${last.metrics.evans3 ?? "—"}%`,
        `${last.metrics.withers ?? "—"}%`,
      ]],
      styles: { halign: "center", fontSize: 8, cellPadding: 3, lineColor: [235, 235, 235], lineWidth: 0.15 },
      headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 7.5, cellPadding: 2 },
      bodyStyles: { fontStyle: "bold", fontSize: 11, cellPadding: 4, textColor: CLUB_NAVY },
      margin: { left: 14, right: 14 },
      // Destaca R&W como referência
      didParseCell: (data) => {
        if (data.section === "body" && data.column.index === 0) {
          data.cell.styles.textColor = CLUB_RED;
        }
      },
    });
  }

  // Título da secção evolução — deslocado mais acima para não colidir com os títulos internos dos gráficos
  let chartY = (doc.lastAutoTable?.finalY ?? kpiY) + 16;
  const chartH = 36;
  const pageH = doc.internal.pageSize.getHeight();
  const footerMargin = 20; // reserva para "Desde 1930 · ..." e paginação
  // Espaço total necessário: 6mm título + chartH + 4mm x-labels + 30mm objetivo (se aplicável)
  const needsGoal = athlete.goal && ((athlete.goal.bf_target_pct != null) || (athlete.goal.imc_target != null));
  const neededH = 6 + chartH + 4 + (needsGoal ? 30 : 0);
  if (chartY + neededH > pageH - footerMargin) {
    doc.addPage();
    drawHeader(doc, `Relatório · ${athlete.nome}`, logo);
    chartY = 40; // depois do header
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...CLUB_NAVY);
  doc.text("EVOLUÇÃO", 14, chartY - 6);
  doc.setDrawColor(...CLUB_NAVY);
  doc.line(14, chartY - 4.5, 30, chartY - 4.5);
  const halfW = (pageW - 28 - 6) / 2;
  const pesoPoints = [
    ...(evals.map((e) => ({ v: e.peso_kg, d: new Date(e.date).toLocaleDateString("pt-PT") })).filter((p) => p.v != null)),
    ...(weighins || []).map((w) => ({ v: w.peso_kg, d: new Date(w.date).toLocaleDateString("pt-PT") })).filter((p) => p.v != null),
  ].sort((a, b) => a.d.localeCompare(b.d));
  const bfPoints = evals.map((e) => ({ v: e.metrics?.rw, d: new Date(e.date).toLocaleDateString("pt-PT") })).filter((p) => p.v != null);
  drawLineChart(doc, "Peso (kg)", pesoPoints, 14, chartY, halfW, chartH, " kg");
  drawLineChart(doc, "% MG · Reilly & Wallace", bfPoints, 14 + halfW + 6, chartY, halfW, chartH, "%");

  // Objetivo (se definido) — usa Y dinâmico depois dos gráficos + labels (+3 abaixo do gráfico)
  const goalY = chartY + chartH + 14;
  const goalInfo = computeGoalStatus({
    currentWeight: last?.peso_kg,
    currentBf: last?.metrics?.rw,
    currentImc: last?.metrics?.imc,
    goal: athlete.goal,
    athlete,
  });
  if (goalInfo.targetWeight != null) {
    const currentBf = last.metrics.rw;
    const currentImc = last.metrics.imc;
    const currentWeight = last.peso_kg;
    const targetWeight = goalInfo.targetWeight;
    const delta = goalInfo.delta ?? 0;
    const alvoLabel = goalInfo.primary === "imc"
      ? `IMC ${goalInfo.targetImc}`
      : `${goalInfo.targetBf}% MG`;
    const atualLabel = goalInfo.primary === "imc"
      ? (currentImc != null ? `${currentImc}` : "—")
      : (currentBf != null ? `${currentBf}%` : "—");
    const atualHeader = goalInfo.primary === "imc" ? "IMC atual" : "% MG atual";
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...CLUB_NAVY);
    doc.text("OBJETIVO", 14, goalY - 3);
    doc.setDrawColor(...CLUB_NAVY);
    doc.line(14, goalY - 1.5, 28, goalY - 1.5);
    autoTable(doc, {
      startY: goalY,
      theme: "plain",
      head: [[atualHeader, "Alvo", "Peso atual", "Peso alvo", "Dif. peso"]],
      body: [[
        atualLabel,
        alvoLabel,
        `${currentWeight} kg`,
        `${targetWeight} kg`,
        `${Math.abs(delta)} kg ${delta > 0.1 ? "a perder" : delta < -0.1 ? "a ganhar" : "no alvo"}`,
      ]],
      styles: { halign: "center", fontSize: 8, cellPadding: 3, lineColor: [235, 235, 235], lineWidth: 0.15 },
      headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 7.5, cellPadding: 2 },
      bodyStyles: { fontStyle: "bold", fontSize: 11, cellPadding: 4, textColor: CLUB_NAVY },
      margin: { left: 14, right: 14 },
      didParseCell: (data) => {
        if (data.section === "body" && data.column.index === 3) {
          data.cell.styles.textColor = CLUB_RED;
        }
      },
    });
  }

  // Nova página: histórico completo
  doc.addPage();
  drawHeader(doc, `Histórico · ${athlete.nome}`, logo);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...CLUB_NAVY);
  doc.text("REGISTO DE AVALIAÇÕES", 14, 46);
  doc.setDrawColor(...CLUB_NAVY);
  doc.line(14, 47.5, 65, 47.5);
  const histHead = [["Data", "Peso (kg)", "% MG (R&W)", "% MG (JP7)", "MG kg", "MM kg", "MM/MG", "IMC", "Soma 8 (mm)"]];
  const histBody = [...evals].reverse().map((e) => {
    const m = e.metrics || {};
    return [
      new Date(e.date).toLocaleDateString("pt-PT"),
      e.peso_kg != null ? String(e.peso_kg) : "—",
      m.rw != null ? `${m.rw}%` : "—",
      m.jp7 != null ? `${m.jp7}%` : "—",
      m.fat_mass_kg != null ? String(m.fat_mass_kg) : "—",
      m.lean_mass_kg != null ? String(m.lean_mass_kg) : "—",
      m.mm_mg_ratio != null ? String(m.mm_mg_ratio) : "—",
      m.imc != null ? String(m.imc) : "—",
      m.soma8 != null ? String(Math.round(m.soma8)) : "—",
    ];
  });
  autoTable(doc, {
    startY: 50,
    head: histHead,
    body: histBody,
    theme: "plain",
    styles: { fontSize: 8.5, cellPadding: 3, halign: "center", lineColor: [235, 235, 235], lineWidth: 0.15 },
    headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 7.5, cellPadding: 2.5 },
    alternateRowStyles: { fillColor: [248, 249, 251] },
    columnStyles: { 0: { fontStyle: "bold", halign: "left", textColor: CLUB_NAVY } },
    margin: { left: 14, right: 14 },
  });

  // Delta primeira vs última (se houver ≥ 2 avaliações)
  if (first && last && first !== last) {
    const y = (doc.lastAutoTable?.finalY ?? 60) + 12;
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...CLUB_NAVY);
    doc.text("PROGRESSO GLOBAL", 14, y - 3);
    doc.setDrawColor(...CLUB_NAVY);
    doc.line(14, y - 1.5, 42, y - 1.5);
    const deltaPeso = last.peso_kg - first.peso_kg;
    const deltaBf = (last.metrics?.rw ?? 0) - (first.metrics?.rw ?? 0);
    const deltaImc = (last.metrics?.imc ?? 0) - (first.metrics?.imc ?? 0);
    autoTable(doc, {
      startY: y,
      theme: "plain",
      head: [["Da 1.ª avaliação", "Até à última", "Dif. Peso", "Dif. % MG", "Dif. IMC"]],
      body: [[
        new Date(first.date).toLocaleDateString("pt-PT"),
        new Date(last.date).toLocaleDateString("pt-PT"),
        `${deltaPeso > 0 ? "+" : ""}${deltaPeso.toFixed(1)} kg`,
        `${deltaBf > 0 ? "+" : ""}${deltaBf.toFixed(1)}%`,
        `${deltaImc > 0 ? "+" : ""}${deltaImc.toFixed(1)}`,
      ]],
      styles: { halign: "center", fontSize: 8, cellPadding: 3, lineColor: [235, 235, 235], lineWidth: 0.15 },
      headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 7.5, cellPadding: 2 },
      bodyStyles: { fontStyle: "bold", fontSize: 11, cellPadding: 4, textColor: CLUB_NAVY },
      margin: { left: 14, right: 14 },
    });
  }

  // Auditoria: registado por / atualizado por
  if (last?.created_by_name || last?.created_at) {
    const y = (doc.lastAutoTable?.finalY ?? 100) + 8;
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(140);
    const parts = [];
    if (last.created_by_name) parts.push(`Última avaliação registada por ${last.created_by_name}`);
    if (last.created_at) parts.push(`em ${new Date(last.created_at).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" })}`);
    doc.text(parts.join(" "), 14, y);
  }

  // Fotos da última avaliação (se existirem)
  try {
    const token = localStorage.getItem("trofense_token");
    const base = process.env.REACT_APP_BACKEND_URL || "";
    const listRes = await fetch(`${base}/api/athletes/${athlete.id}/photos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (listRes.ok && last) {
      const list = await listRes.json();
      // Escolhe, para cada tipo, a foto ligada à última avaliação; se não houver, cai para a mais recente sem evaluation_id.
      const pickPhoto = (kind) => {
        const cands = (list || []).filter((p) => p.kind === kind && (p.evaluation_id === last.id || p.evaluation_id == null));
        cands.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return cands[0] || null;
      };
      const evPhotos = ["frontal", "perfil", "costas"].map(pickPhoto);
      if (evPhotos.some(Boolean)) {
        // Página em LANDSCAPE para dar espaço às 3 fotos lado a lado
        doc.addPage("a4", "landscape");
        drawHeader(doc, `Fotografias · Última avaliação`, logo);
        const lPageW = doc.internal.pageSize.getWidth();  // 297mm em landscape
        const lPageH = doc.internal.pageSize.getHeight(); // 210mm em landscape

        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(...CLUB_NAVY);
        doc.text("REGISTO FOTOGRÁFICO", 14, 46);
        doc.setDrawColor(...CLUB_NAVY);
        doc.line(14, 47.5, 60, 47.5);
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(80);
        doc.text(`Data: ${new Date(last.date).toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" })}`, 14, 52);

        const marginX = 12;
        const gap = 8;
        const boxW = (lPageW - marginX * 2 - gap * 2) / 3;
        // Altura disponível: entre y=58 e footer (bottom - 15) → 210 - 58 - 20 = 132mm
        const availH = lPageH - 58 - 22;
        // Aspect natural de fotos corporais: 3:4 → h = w * 1.33. Se a caixa for maior, respeitamos o menor.
        const boxH = Math.min(availH, boxW * 1.33);
        const y = 60;
        const labels = { frontal: "Frente", perfil: "Perfil", costas: "Costas" };
        const order = ["frontal", "perfil", "costas"];
        for (let i = 0; i < order.length; i++) {
          const p = evPhotos[i];
          const x = marginX + (boxW + gap) * i;
          doc.setFillColor(245, 246, 249);
          doc.setDrawColor(...CLUB_NAVY);
          doc.setLineWidth(0.4);
          doc.rect(x, y, boxW, boxH, "FD");
          if (p) {
            const data = await fetchPhotoAsDataUrl(p.id);
            if (data) {
              try {
                const size = await getImageSize(data);
                const fit = fitContain(size.w, size.h, x + 1, y + 1, boxW - 2, boxH - 2);
                doc.addImage(data, "JPEG", fit.x, fit.y, fit.w, fit.h);
              } catch { /* ignore */ }
            }
          } else {
            doc.setTextColor(160);
            doc.setFontSize(11);
            doc.setFont("helvetica", "italic");
            doc.text("Sem foto", x + boxW / 2, y + boxH / 2, { align: "center" });
          }
          // Legenda por baixo
          doc.setFontSize(11);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(...CLUB_NAVY);
          doc.text(labels[order[i]], x + boxW / 2, y + boxH + 8, { align: "center" });
        }
      }
    }
  } catch { /* ignore */ }

  drawFooter(doc);
  const safe = (athlete.nome || "atleta").replace(/[^\w-]+/g, "_");
  const filename = `trofense_${safe}_${new Date().toISOString().slice(0, 10)}.pdf`;
  if (saveFile) {
    doc.save(filename);
    return { doc, filename };
  }
  return { doc, filename };
}

/** Gera o PDF individual do atleta e devolve-o como base64 (para envio por email). */
export async function exportAthletePdfAsBase64(athlete, evals, weighins) {
  const { doc, filename } = await exportAthletePdf(athlete, evals, weighins, false);
  const dataUri = doc.output("datauristring");
  const base64 = dataUri.split(",")[1];
  return { base64, filename };
}

// Re-export computeGoalStatus for convenience if needed by callers
export { computeGoalStatus };

/** PDF do Relatório Mensal Comparativo — landscape com duas colunas por métrica (A/U).
 *  Formato inspirado no template do departamento médico.
 *  @param {object} data { month_a, month_b, rows } vindo de GET /api/reports/monthly
 *  @param {object} meta { season?, doctor? } opcional para o cabeçalho
 */
export async function exportMonthlyReportPdf(data, meta = {}) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const logo = await getLogoDataUrl();
  const pageW = doc.internal.pageSize.getWidth();

  // ---------- Header custom (mais compacto para tabela larga) ----------
  doc.setFillColor(...CLUB_NAVY);
  doc.rect(0, 0, pageW, 26, "F");
  doc.setFillColor(...CLUB_RED);
  doc.rect(0, 26, pageW, 1.2, "F");
  doc.setFillColor(...CLUB_YELLOW);
  doc.rect(0, 27.2, pageW, 0.6, "F");
  if (logo) { try { doc.addImage(logo, "PNG", 10, 4, 18, 18); } catch { /* skip */ } }
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("CLUBE DESPORTIVO TROFENSE", 32, 10);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Departamento Médico", 32, 15);
  if (meta.season) doc.text(`Época ${meta.season}`, 32, 20);
  if (meta.doctor) doc.text(`Dr. ${meta.doctor}`, 32, 24);

  // Título grande centrado
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255);
  doc.text("Relatório Mensal · Avaliação Antropométrica", pageW / 2, 12, { align: "center" });
  // Meses comparados a vermelho
  const monthLabel = (m) => new Date(m + "-01").toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
  doc.setTextColor(...CLUB_YELLOW);
  doc.setFontSize(11);
  doc.text(
    `${monthLabel(data.month_a)}  >>  ${monthLabel(data.month_b)}`,
    pageW / 2, 20, { align: "center" }
  );
  // data topo direito
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(255);
  doc.text(new Date().toLocaleString("pt-PT", { dateStyle: "long", timeStyle: "short" }), pageW - 10, 20, { align: "right" });

  // ---------- Tabela ----------
  const fmt = (v, suffix = "") => v == null ? "—" : `${v}${suffix}`;
  const fmtDelta = (v, suffix = "") => {
    if (v == null) return "—";
    const sign = v > 0 ? "+" : "";
    return `${sign}${v}${suffix}`;
  };

  const head = [[
    { content: "Nome", rowSpan: 2, styles: { valign: "middle" } },
    { content: "Alt.", rowSpan: 2, styles: { valign: "middle", halign: "center" } },
    { content: "Peso (kg)", colSpan: 3, styles: { halign: "center" } },
    { content: "Soma Pregas (mm)", colSpan: 2, styles: { halign: "center" } },
    { content: "% Massa Gorda", colSpan: 2, styles: { halign: "center" } },
    { content: "Massa Muscular (kg)", colSpan: 2, styles: { halign: "center" } },
    { content: "PMC (cm)", colSpan: 2, styles: { halign: "center" } },
  ], [
    { content: "Ant.", styles: { halign: "center" } },
    { content: "Atual", styles: { halign: "center" } },
    { content: "Dif.", styles: { halign: "center" } },
    { content: "Ant.", styles: { halign: "center" } },
    { content: "Atual", styles: { halign: "center" } },
    { content: "Ant.", styles: { halign: "center" } },
    { content: "Atual", styles: { halign: "center" } },
    { content: "Ant.", styles: { halign: "center" } },
    { content: "Atual", styles: { halign: "center" } },
    { content: "Ant.", styles: { halign: "center" } },
    { content: "Atual", styles: { halign: "center" } },
  ]];

  const body = data.rows
    .filter((r) => r.month_a.has_eval || r.month_b.has_eval)  // omite atletas sem qualquer avaliação nos 2 meses
    .map((r) => {
      const a = r.month_a, b = r.month_b;
      const alturaM = r.altura_cm ? (r.altura_cm / 100).toFixed(2) : "—";
      return [
        r.nome,
        alturaM,
        fmt(a.peso, ""),
        fmt(b.peso, ""),
        { content: fmtDelta(r.delta.peso, ""), delta: r.delta.peso, styles: { fontStyle: "bold" } },
        fmt(a.soma8),
        fmt(b.soma8),
        fmt(a.bf, "%"),
        fmt(b.bf, "%"),
        fmt(a.muscle_mass_kg),
        fmt(b.muscle_mass_kg),
        fmt(a.pmc),
        fmt(b.pmc),
      ];
    });

  // Totais (média) na última linha
  const nums = (getter) => data.rows.map((r) => getter(r)).filter((v) => v != null);
  const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
  const alturas = nums((r) => r.altura_cm ? r.altura_cm / 100 : null);
  const foot = [[
    { content: "Média", styles: { fontStyle: "bold", fillColor: [235, 238, 245], textColor: CLUB_NAVY } },
    { content: alturas.length ? (alturas.reduce((a, b) => a + b, 0) / alturas.length).toFixed(2) : "—", styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_a.peso))), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_b.peso))), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.delta.peso))), styles: { halign: "center", fillColor: [235, 238, 245], fontStyle: "bold" } },
    { content: fmt(avg(nums((r) => r.month_a.soma8))), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_b.soma8))), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_a.bf)), "%"), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_b.bf)), "%"), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_a.muscle_mass_kg))), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_b.muscle_mass_kg))), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_a.pmc))), styles: { halign: "center", fillColor: [235, 238, 245] } },
    { content: fmt(avg(nums((r) => r.month_b.pmc))), styles: { halign: "center", fillColor: [235, 238, 245] } },
  ]];

  autoTable(doc, {
    head,
    body,
    foot,
    startY: 34,
    theme: "grid",
    styles: { fontSize: 7.8, cellPadding: 1.6, lineColor: [220, 220, 225], lineWidth: 0.15, halign: "center" },
    headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 7.5, fontStyle: "bold", cellPadding: 2 },
    footStyles: { fillColor: [235, 238, 245], textColor: CLUB_NAVY, fontStyle: "bold" },
    columnStyles: {
      0: { halign: "left", fontStyle: "bold", cellWidth: 40, textColor: CLUB_NAVY },
    },
    // Colorização das células Atual vs Ant baseada no delta (verde = melhoria, vermelho = agravamento)
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const row = body[data.row.index];
      if (!row) return;
      const idx = data.column.index;
      const deltaPeso = row[4]?.delta;
      // Peso: coluna 4 é o delta — pinta o delta
      if (idx === 4 && deltaPeso != null) {
        if (deltaPeso > 0.5) data.cell.styles.textColor = [220, 25, 40];   // ganhou peso — vermelho
        else if (deltaPeso < -0.5) data.cell.styles.textColor = [16, 185, 129]; // perdeu peso — verde
      }
      // Massa gorda "atual" (col 8): compara com "anterior" (col 7) — mais MG = pior
      if (idx === 8) {
        const prev = parseFloat(String(row[7]).replace("%", ""));
        const curr = parseFloat(String(row[8]).replace("%", ""));
        if (!isNaN(prev) && !isNaN(curr)) {
          if (curr - prev > 0.5) { data.cell.styles.fillColor = [253, 232, 235]; }
          else if (curr - prev < -0.5) { data.cell.styles.fillColor = [220, 252, 231]; }
        }
      }
      // Massa muscular "atual" (col 10): mais MM = melhor
      if (idx === 10) {
        const prev = parseFloat(row[9]);
        const curr = parseFloat(row[10]);
        if (!isNaN(prev) && !isNaN(curr)) {
          if (curr - prev > 0.3) { data.cell.styles.fillColor = [220, 252, 231]; }
          else if (curr - prev < -0.3) { data.cell.styles.fillColor = [253, 232, 235]; }
        }
      }
    },
    margin: { top: 34, left: 8, right: 8, bottom: 15 },
  });

  // ---------- Página Resumo ----------
  drawMonthlySummaryPage(doc, data, meta, logo);

  drawFooter(doc);
  const filename = `trofense-relatorio-mensal-${data.month_a}-vs-${data.month_b}.pdf`;
  doc.save(filename);
  return { filename };
}

/** Página resumo do relatório mensal — KPIs + destaques. */
function drawMonthlySummaryPage(doc, data, meta, logoData) {
  doc.addPage("a4", "landscape");
  const pageW = doc.internal.pageSize.getWidth();

  // Header compacto igual ao da tabela principal
  doc.setFillColor(...CLUB_NAVY);
  doc.rect(0, 0, pageW, 26, "F");
  doc.setFillColor(...CLUB_RED);
  doc.rect(0, 26, pageW, 1.2, "F");
  doc.setFillColor(...CLUB_YELLOW);
  doc.rect(0, 27.2, pageW, 0.6, "F");
  if (logoData) { try { doc.addImage(logoData, "PNG", 10, 4, 18, 18); } catch { /* skip */ } }
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("CLUBE DESPORTIVO TROFENSE", 32, 10);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Departamento Médico · Resumo Executivo", 32, 15);
  if (meta.season) doc.text(`Época ${meta.season}`, 32, 20);
  if (meta.doctor) doc.text(`Dr. ${meta.doctor}`, 32, 24);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Resumo Executivo · Evolução do Plantel", pageW / 2, 14, { align: "center" });

  // Cálculo dos KPIs (só considera atletas com avaliação nos DOIS meses)
  const rowsWithBoth = data.rows.filter((r) => r.month_a.has_eval && r.month_b.has_eval);
  const N = rowsWithBoth.length;

  const nums = (getter) => rowsWithBoth.map(getter).filter((v) => v != null && !isNaN(v));
  const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;

  const deltaPesoAvg = avg(nums((r) => r.delta.peso));
  const deltaSoma8Avg = avg(nums((r) => r.delta.soma8));
  const reduzMG = rowsWithBoth.filter((r) => r.delta.bf != null && r.delta.bf < -0.1).length;
  const ganhaMM = rowsWithBoth.filter((r) => r.delta.muscle_mass_kg != null && r.delta.muscle_mass_kg > 0.1).length;

  // Cards KPI
  const cardY = 38;
  const cardH = 26;
  const gap = 6;
  const cardW = (pageW - 20 - gap * 3) / 4;
  const kpis = [
    {
      label: "Dif. Peso médio do plantel",
      value: deltaPesoAvg == null ? "—" : `${deltaPesoAvg > 0 ? "+" : ""}${deltaPesoAvg} kg`,
      color: deltaPesoAvg == null ? [140, 140, 140] : (deltaPesoAvg < -0.1 ? [16, 185, 129] : deltaPesoAvg > 0.1 ? CLUB_RED : CLUB_NAVY),
    },
    {
      label: "Reduziram % MG",
      value: N ? `${reduzMG} / ${N}` : "—",
      color: [16, 185, 129],
    },
    {
      label: "Ganharam Massa Muscular",
      value: N ? `${ganhaMM} / ${N}` : "—",
      color: [16, 185, 129],
    },
    {
      label: "Dif. Soma Pregas médio",
      value: deltaSoma8Avg == null ? "—" : `${deltaSoma8Avg > 0 ? "+" : ""}${deltaSoma8Avg} mm`,
      color: deltaSoma8Avg == null ? [140, 140, 140] : (deltaSoma8Avg < 0 ? [16, 185, 129] : CLUB_RED),
    },
  ];
  kpis.forEach((k, i) => {
    const x = 10 + i * (cardW + gap);
    doc.setDrawColor(220);
    doc.setFillColor(248, 249, 251);
    doc.roundedRect(x, cardY, cardW, cardH, 1.5, 1.5, "FD");
    doc.setTextColor(120);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(k.label.toUpperCase(), x + 4, cardY + 6);
    doc.setTextColor(...k.color);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(k.value, x + 4, cardY + 20);
  });

  // ---------- Destaques (Top 3 melhorias) ----------
  const sectionY = cardY + cardH + 12;
  doc.setTextColor(...CLUB_NAVY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Destaques do mês", 10, sectionY);
  doc.setDrawColor(...CLUB_RED);
  doc.setLineWidth(0.5);
  doc.line(10, sectionY + 1.5, 55, sectionY + 1.5);

  const top3 = (arr, sortKey, asc = true) => [...arr]
    .filter((r) => r.delta[sortKey] != null)
    .sort((a, b) => asc ? a.delta[sortKey] - b.delta[sortKey] : b.delta[sortKey] - a.delta[sortKey])
    .slice(0, 3);

  const topMG = top3(rowsWithBoth, "bf", true);       // menor delta MG = maior redução
  const topMM = top3(rowsWithBoth, "muscle_mass_kg", false); // maior delta MM = maior ganho
  const topPeso = top3(rowsWithBoth, "peso", true);    // menor delta peso = maior perda

  const listY = sectionY + 6;
  const listH = 46;
  const listW = (pageW - 20 - gap * 2) / 3;

  const drawList = (x, title, rows, unit, positiveIsGood) => {
    doc.setDrawColor(220);
    doc.setFillColor(255);
    doc.rect(x, listY, listW, listH, "S");
    doc.setFillColor(...CLUB_NAVY);
    doc.rect(x, listY, listW, 6, "F");
    doc.setTextColor(255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(title.toUpperCase(), x + 3, listY + 4);
    doc.setTextColor(60);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    if (rows.length === 0) {
      doc.setTextColor(140);
      doc.setFont("helvetica", "italic");
      doc.text("Sem dados suficientes", x + 3, listY + 15);
      return;
    }
    rows.forEach((r, i) => {
      const y = listY + 12 + i * 11;
      // rank badge
      doc.setFillColor(...CLUB_YELLOW);
      doc.circle(x + 5, y - 1.5, 2.2, "F");
      doc.setTextColor(...CLUB_NAVY);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.text(String(i + 1), x + 5, y, { align: "center", baseline: "middle" });
      // name
      doc.setTextColor(...CLUB_NAVY);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.text(r.nome.length > 22 ? r.nome.substring(0, 21) + "…" : r.nome, x + 10, y);
      // delta
      const dKey = title.includes("MG") ? "bf" : title.includes("Muscular") ? "muscle_mass_kg" : "peso";
      const val = r.delta[dKey];
      const sign = val > 0 ? "+" : "";
      const good = positiveIsGood ? val > 0 : val < 0;
      doc.setTextColor(...(good ? [16, 185, 129] : CLUB_RED));
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(`${sign}${val}${unit}`, x + listW - 3, y, { align: "right" });
    });
  };

  drawList(10, "Top 3 · redução de % MG", topMG, "%", false);
  drawList(10 + listW + gap, "Top 3 · ganho de Massa Muscular", topMM, " kg", true);
  drawList(10 + (listW + gap) * 2, "Top 3 · maior perda de peso", topPeso, " kg", false);

  // ---------- Alertas ----------
  const alertY = listY + listH + 10;
  const alertsPeso = rowsWithBoth.filter((r) => r.delta.peso != null && r.delta.peso > 1);
  const alertsMG = rowsWithBoth.filter((r) => r.delta.bf != null && r.delta.bf > 0.5);
  const alerts = [...new Set([...alertsPeso, ...alertsMG].map((r) => r.athlete_id))]
    .map((id) => rowsWithBoth.find((r) => r.athlete_id === id))
    .filter(Boolean);

  doc.setTextColor(...CLUB_RED);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Alertas · atenção necessária", 10, alertY);
  doc.setDrawColor(...CLUB_RED);
  doc.line(10, alertY + 1.5, 70, alertY + 1.5);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(120);
  doc.text("Dif. peso > 1 kg ou Dif. % MG > 0,5%", 10, alertY + 6);

  if (alerts.length === 0) {
    doc.setTextColor(16, 185, 129);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Sem alertas — plantel dentro dos limites este mês.", 10, alertY + 16);
  } else {
    autoTable(doc, {
      startY: alertY + 8,
      theme: "grid",
      head: [["Atleta", "Peso Ant.", "Peso Atual", "Dif. Peso", "% MG Ant.", "% MG Atual", "Dif. % MG"]],
      body: alerts.map((r) => {
        const dp = r.delta.peso;
        const dmg = r.delta.bf;
        return [
          r.nome,
          r.month_a.peso ?? "—",
          r.month_b.peso ?? "—",
          { content: dp != null ? `${dp > 0 ? "+" : ""}${dp} kg` : "—", styles: { textColor: dp != null && dp > 1 ? CLUB_RED : [60, 60, 60], fontStyle: "bold" } },
          r.month_a.bf != null ? `${r.month_a.bf}%` : "—",
          r.month_b.bf != null ? `${r.month_b.bf}%` : "—",
          { content: dmg != null ? `${dmg > 0 ? "+" : ""}${dmg}%` : "—", styles: { textColor: dmg != null && dmg > 0.5 ? CLUB_RED : [60, 60, 60], fontStyle: "bold" } },
        ];
      }),
      styles: { fontSize: 9, cellPadding: 2, lineColor: [230, 230, 235], lineWidth: 0.15, halign: "center" },
      headStyles: { fillColor: CLUB_NAVY, textColor: 255, fontSize: 8, fontStyle: "bold" },
      columnStyles: {
        0: { halign: "left", fontStyle: "bold", cellWidth: 55, textColor: CLUB_NAVY },
      },
      margin: { left: 10, right: 10 },
    });
  }
}
