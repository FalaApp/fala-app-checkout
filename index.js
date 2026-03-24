const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'cadastro-e-checkout-fala-app.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
