CREATE TABLE public.worlds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seed BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.world_edits (
  id BIGSERIAL PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES public.worlds(id) ON DELETE CASCADE,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  block TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_world_edits_world_id_id ON public.world_edits (world_id, id);
CREATE INDEX idx_worlds_last_active_at ON public.worlds (last_active_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.worlds TO anon, authenticated;
GRANT SELECT, INSERT ON public.world_edits TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.world_edits_id_seq TO anon, authenticated;
GRANT ALL ON public.worlds TO service_role;
GRANT ALL ON public.world_edits TO service_role;
GRANT ALL ON SEQUENCE public.world_edits_id_seq TO service_role;

ALTER TABLE public.worlds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.world_edits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read worlds" ON public.worlds FOR SELECT USING (true);
CREATE POLICY "Anyone can create worlds" ON public.worlds FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can touch worlds" ON public.worlds FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Anyone can read world edits" ON public.world_edits FOR SELECT USING (true);
CREATE POLICY "Anyone can add world edits" ON public.world_edits FOR INSERT WITH CHECK (true);