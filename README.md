# Acoustic Ray Tracing

Браузерный симулятор акустики помещения. Рисуешь план комнаты, расставляешь источники звука и слушателя, загружаешь своё аудио или включаешь тестовый сигнал — и слышишь в наушниках, как оно звучит в этой комнате. Всё считается локально в браузере (Rust → WebAssembly в веб-воркере), сервер не нужен.

## Локальный запуск

Нужны [Node.js](https://nodejs.org/) 20+ и [Rust](https://rustup.rs/) с таргетом WebAssembly:

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run dev
```

`npm run dev` собирает ядро в `src/wasm/core.wasm` и запускает Vite; адрес откроется в консоли (обычно http://localhost:5173). Для звука нужны наушники.

Прочее: `npm run build` и `npm run preview` — продакшен-сборка и её просмотр, `npm run test:all` — тесты Rust и TypeScript.
