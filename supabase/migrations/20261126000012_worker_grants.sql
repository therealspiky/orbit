-- The worker (service role) runs promise nudges on a timer.
grant execute on function public.run_promise_nudges(date) to service_role;
