import axios from "axios";

const apiBaseUrl =
    import.meta.env.VITE_API_BASE_URL ??
    `http://${window.location.hostname || "localhost"}:2020`;

const api = axios.create({
    baseURL: apiBaseUrl,
    withCredentials: true,
    // Render free instances may need roughly 50 seconds to wake. Keep enough
    // headroom for a cold start, but never leave buttons spinning forever.
    timeout: 75000,
})

api.interceptors.response.use((response) => response, (error) => {
    if (error?.response?.status === 401 && !['/auth/login', '/auth/register', '/auth/accept-invite'].includes(error.config?.url)) {
        window.dispatchEvent(new Event('auth-expired'));
    }
    return Promise.reject(error);
});

export default api;
