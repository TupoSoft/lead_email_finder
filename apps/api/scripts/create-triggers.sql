drop trigger if exists credit_ledger_balance_safe;

create trigger credit_ledger_balance_safe
    after insert
    on credit_ledger
    when (select sum(delta)
          from credit_ledger
          where user_id = new.user_id) not between -9007199254740991 and 9007199254740991
begin
    select raise(abort, 'Credit ledger balance exceeds safe integer range.');
end;
