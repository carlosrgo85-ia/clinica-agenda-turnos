-- Por qué un equipo está fuera de servicio.
--
-- Un equipo apagado sin explicación es indistinguible de uno apagado por
-- error, y mientras tanto todos los servicios que dependen de él dejan de
-- poder agendarse. El motivo también viaja a la derivación que se genera
-- cuando un paciente pide justo ese servicio.
ALTER TABLE "Resource" ADD COLUMN "inactiveReason" TEXT;
