WITH repaired AS MATERIALIZED (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY display_order ASC, id ASC) - 1 AS display_order
  FROM habits
  WHERE EXISTS (
    SELECT 1 FROM habits GROUP BY display_order HAVING COUNT(*) > 1
  )
)
UPDATE habits
SET display_order = (SELECT display_order FROM repaired WHERE repaired.id = habits.id)
WHERE id IN (SELECT id FROM repaired);
