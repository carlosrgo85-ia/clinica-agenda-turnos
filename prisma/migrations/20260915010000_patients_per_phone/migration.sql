-- Un mismo WhatsApp puede tener varias fichas de paciente.
--
-- Mientras `Patient` estuvo identificado por teléfono, una familia que
-- comparte un número era una sola persona: el turno de la hija quedaba a
-- nombre del padre, el CRM los mezclaba en una ficha, y la regla de
-- "primera vez con el profesional principal" no se aplicaba a quien
-- realmente venía por primera vez, porque el número ya tenía turnos.
--
-- El teléfono sigue identificando la CONVERSACIÓN (`ConversationMessage`
-- se guarda por número, no por paciente). Lo que pasa a resolverse por
-- persona es de quién es cada turno.
DROP INDEX "Patient_clinicId_phone_key";

CREATE INDEX "Patient_clinicId_phone_idx" ON "Patient"("clinicId", "phone");
