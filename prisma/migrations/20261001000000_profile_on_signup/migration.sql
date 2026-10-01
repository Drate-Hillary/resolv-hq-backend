-- Creates the public.profiles (+ customer_profiles) rows when a Supabase auth
-- user signs up. Without this, sign-up succeeded in auth.users but the
-- backend's requireAuth rejected every request with "No profile for this
-- user". Always role 'customer': staff accounts are promoted by hand.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  full_name text := nullif(btrim(coalesce(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name', '')), '');
BEGIN
  INSERT INTO public.profiles (id, first_name, last_name, email, role, status)
  VALUES (
    NEW.id,
    coalesce(split_part(full_name, ' ', 1), split_part(NEW.email, '@', 1), 'User'),
    nullif(btrim(substr(coalesce(full_name, ''), length(split_part(full_name, ' ', 1)) + 1)), ''),
    NEW.email,
    'customer',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.customer_profiles (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill users who signed up before the trigger existed.
INSERT INTO public.profiles (id, first_name, last_name, email, role, status)
SELECT
  u.id,
  coalesce(split_part(nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), ''), ' ', 1), split_part(u.email, '@', 1), 'User'),
  nullif(btrim(substr(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', ''), length(split_part(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', ''), ' ', 1)) + 1)), ''),
  u.email,
  'customer',
  'active'
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

INSERT INTO public.customer_profiles (user_id)
SELECT p.id FROM public.profiles p
LEFT JOIN public.customer_profiles c ON c.user_id = p.id
WHERE p.role = 'customer' AND c.user_id IS NULL;
