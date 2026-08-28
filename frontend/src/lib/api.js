import axios from "axios";

// Em produção o frontend e o backend vivem no mesmo domínio Vercel, por isso
// o caminho por omissão é relativo ("/api"). Definir REACT_APP_BACKEND_URL
// só é necessário em desenvolvimento local (backend noutra porta/domínio).
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
export const API = `${BACKEND}/api`;

export const api = axios.create({
  baseURL: API,
  withCredentials: true,
});

// Attach bearer token from localStorage as a robust fallback (cookie SameSite=none
// works in modern browsers but Authorization header ensures reliability).
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("trofense_token");
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function formatApiError(detail) {
  if (detail == null) return "Erro inesperado. Tente novamente.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail.map((e) => (e && typeof e.msg === "string" ? e.msg : JSON.stringify(e))).join(" ");
  if (detail && typeof detail.msg === "string") return detail.msg;
  return String(detail);
}
