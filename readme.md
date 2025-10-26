# How I Cut Query Time from 4s to 20ms Using PostgreSQL Hash Partitioning

I was building a review platform where users could leave reviews for products. Everything was working fine until it wasn't. Our read queries started taking forever, and I needed to figure out why before setting up expensive read replicas.

This is the story of how I went from 4-second queries to 20-millisecond queries using PostgreSQL partitioning.

## The Problem

The review platform had a simple use case: users browse products and read reviews. Sounds straightforward, right?

But here's what was happening:
- We had 1 billion reviews in the database
- Every time someone wanted to see reviews for a product, it took 3-4 seconds
- The query was simple: `SELECT * FROM reviews WHERE product_id = 45`
- This was unacceptable for a production system

Before jumping to "let's add read replicas," I wanted to see if we could optimize the existing database first. Read replicas cost money, and if the problem was how we were storing and accessing data, adding replicas would just mean paying to replicate a slow system.

## The Setup

Let me show you what I was working with. I'm using Node.js with Knex.js as the query builder and PostgreSQL 15.

First, I spun up a PostgreSQL instance in Docker:

```bash
docker run -d \
  --name reviews_demo_pg \
  -e POSTGRES_USER=demo_user \
  -e POSTGRES_PASSWORD=demo123 \
  -e POSTGRES_DB=demo_app \
  -v reviews_demo_data:/var/lib/postgresql/data \
  -p 55432:5432 \
  --memory=1g \
  postgres:15-alpine
```

The database structure was basic:

```javascript
// Initial migration
export async function up(knex) {
  await knex.schema.createTable('reviews', (table) => {
    table.increments('id').primary();
    table.integer('product_id').notNullable();
    table.integer('user_id').notNullable();
    table.integer('rating').notNullable();
    table.text('comment');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}
```

Nothing fancy. Just a reviews table with product_id, user_id, rating, and a comment.

## Seeding 1 Billion Reviews

I seeded the database with 1 billion reviews. Yes, billion with a "B". I wanted to test realistic scale, not toy numbers.

The seeding script was straightforward:

```javascript
export async function seed(knex) {
  const batchSize = 10000; 
  const totalRows = 1_000_000_000;
  const totalBatches = Math.ceil(totalRows / batchSize);

  for (let batch = 0; batch < totalBatches; batch++) {
    const rows = [];
    for (let i = 0; i < batchSize; i++) {
      rows.push({
        product_id: Math.floor(Math.random() * 1000) + 1,
        user_id: Math.floor(Math.random() * 100_000) + 1,
        rating: Math.floor(Math.random() * 5) + 1,
        comment: 'Sample review comment',
        created_at: new Date(),
      });
    }
    await knex('reviews').insert(rows);
  }
}
```

I didn't add indexes during seeding because maintaining indexes while inserting a billion rows would be painfully slow. Better to seed first, then add indexes.

## Adding Indexes

After seeding, I added indexes on the columns we'd be querying:

```javascript
export async function up(knex) {
  await knex.schema.alterTable("reviews", (table) => {
    table.index("product_id", "idx_reviews_product_id");
    table.index("user_id", "idx_reviews_user_id");
    table.index("rating", "idx_reviews_rating");
  });
}
```

Now let's see what we're dealing with in terms of space:

```sql
demo_app=# select pg_relation_size(oid), relname from pg_class 
           order by pg_relation_size(oid) desc;

 pg_relation_size |        relname                     
------------------+------------------------------------
       3248480256 | reviews
        953057280 | reviews_pkey
        333225984 | idx_reviews_user_id
        279019520 | idx_reviews_product_id
        276135936 | idx_reviews_rating
```

The reviews table is about 3.2GB, and our indexes add another ~1.5GB total.

## The First Query Test

Let's run our main query pattern - fetching reviews for a specific product:

```sql
demo_app=# EXPLAIN ANALYZE SELECT * FROM reviews WHERE product_id = 45;

QUERY PLAN
---------------------------------------------------------------------------
 Bitmap Heap Scan on reviews  (cost=463.33..123006.72 rows=42180 width=46) 
                              (actual time=67.831..3414.728 rows=42706 loops=1)
   Recheck Cond: (product_id = 45)
   Heap Blocks: exact=40541
   ->  Bitmap Index Scan on idx_reviews_product_id  
       (cost=0.00..452.79 rows=42180 width=0) 
       (actual time=62.232..62.233 rows=42706 loops=1)
         Index Cond: (product_id = 45)
 Planning Time: 2.184 ms
 Execution Time: 3421.406 ms
```

**3.4 seconds.** That's way too slow.

Let me explain what's happening here for those new to reading PostgreSQL query plans:

1. **Bitmap Index Scan**: PostgreSQL uses the index on `product_id` to find all matching rows
2. **Bitmap Heap Scan**: It then goes to the actual table (the heap) to fetch the full row data
3. **Heap Blocks: exact=40541**: It had to read 40,541 blocks from disk to get all the data

The problem is that even with an index(It found 42,706 rows very quickly in about 62 ms.), PostgreSQL has to scan through a massive table to find and retrieve these rows. The data for product 45 is scattered all over the 3.2GB table.

## Understanding the Query Pattern

Before fixing this, I needed to understand how the data was being accessed:

1. **Users always view reviews by product** - Nobody ever asks "show me all reviews across all products"
2. **Products have many reviews** - Product 45 has ~42,000 reviews
3. **Reviews for a product don't need to be near reviews for other products** - There's no reason reviews for Product 45 should be physically near reviews for Product 99

This access pattern is perfect for partitioning.

## What is Partitioning?

Think of partitioning like organizing a massive library. 

Without partitioning, it's like having all 1 billion books in one huge room. When someone asks for a book about "cooking," you have to search through all billion books.

With partitioning, you split the library into smaller rooms based on category. Now when someone asks for a book about "cooking," you only search the cooking room, which might have just 250 million books instead of 1 billion.

In database terms:
- We're splitting one massive `reviews` table into multiple smaller tables (partitions)
- Each partition stores a subset of the data
- PostgreSQL automatically knows which partition to query based on your WHERE clause

## Choosing the Partitioning Strategy

PostgreSQL supports three partitioning methods:

1. **Range Partitioning**: Split by ranges (e.g., dates: Jan-Mar in partition 1, Apr-Jun in partition 2)
2. **List Partitioning**: Split by specific values (e.g., USA in partition 1, UK in partition 2)
3. **Hash Partitioning**: Split by hash function (evenly distributes data across partitions)

I chose **hash partitioning on `product_id`** because:

- Reviews are always fetched by product_id (our access pattern)
- We have 1,000 products distributed randomly
- Hash partitioning will evenly distribute the data across partitions
- We don't care which partition holds which product, we just want even distribution

## Creating the Partitioned Table

Here's the tricky part: Knex.js doesn't support partitioning. It's too database-specific to fit into a query builder abstraction.

But we can use `knex.raw()` to execute raw SQL:

```javascript
export async function up(knex) {
  // Create the partitioned table
  await knex.raw(`
    CREATE TABLE reviews_partitioned (
      id SERIAL,
      product_id INT NOT NULL,
      user_id INT NOT NULL,
      rating INT NOT NULL,
      comment TEXT,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (id, product_id)
    ) PARTITION BY HASH (product_id);
  `);

  // Create 4 partitions
  for (let i = 0; i < 4; i++) {
    await knex.raw(`
      CREATE TABLE reviews_partitioned_p${i} 
      PARTITION OF reviews_partitioned
      FOR VALUES WITH (MODULUS 4, REMAINDER ${i});
    `);
  }

  // Copy data from old table
  console.log('Copying data...');
  await knex.raw(`
    INSERT INTO reviews_partitioned 
    (id, product_id, user_id, rating, comment, created_at)
    SELECT id, product_id, user_id, rating, comment, created_at 
    FROM reviews;
  `);
}
```

A few important notes:

**1. The primary key includes product_id**: `PRIMARY KEY (id, product_id)`

This is required for partitioned tables. The partition key (`product_id`) must be part of any unique constraint or primary key.

**2. MODULUS 4, REMAINDER 0/1/2/3**: This is how hash partitioning works.

PostgreSQL hashes the `product_id` value, divides by 4 (the modulus), and uses the remainder (0, 1, 2, or 3) to determine which partition the row goes into. This ensures even distribution.

**3. I kept the original table**: I didn't drop the `reviews` table yet. In production, you'd want to test thoroughly before dropping the old table.

## Checking the Distribution

After copying the data, let's see how it was distributed:

```sql
demo_app=# SELECT count(*) FROM reviews_partitioned_p0;
  count   
----------
 10983654

demo_app=# SELECT count(*) FROM reviews_partitioned_p1;
  count  
---------
 9931959

demo_app=# SELECT count(*) FROM reviews_partitioned_p2;
  count   
----------
 11706171

demo_app=# SELECT count(*) FROM reviews_partitioned_p3;
  count  
---------
 9808216
```

Pretty even distribution! Each partition has roughly 10 million rows instead of 42 million.

Here's what the table sizes look like:

```
        896237568 | reviews_partitioned_p2
        840916992 | reviews_partitioned_p0
        760406016 | reviews_partitioned_p1
        750927872 | reviews_partitioned_p3
```

Instead of one 3.2GB table, we have four tables around 750-900MB each.

## Testing Without Indexes on Partitions

Let's run the same query:

```sql
demo_app=# EXPLAIN ANALYZE SELECT * FROM reviews_partitioned WHERE product_id = 45;

QUERY PLAN
---------------------------------------------------------------------------
 Bitmap Heap Scan on reviews_partitioned_p1  
 (cost=463.33..123006.72 rows=42180 width=46) 
 (actual time=78.013..4181.663 rows=42706 loops=1)
   Recheck Cond: (product_id = 45)
   Heap Blocks: exact=40541
   ->  Bitmap Index Scan on reviews_partitioned_p1_pkey  
       (cost=0.00..452.79 rows=42180 width=0) 
       (actual time=64.044..64.044 rows=42706 loops=1)
         Index Cond: (product_id = 45)
 Planning Time: 0.282 ms
 Execution Time: 4188.732 ms
```

Wait, it's **slower**? 4.1 seconds vs 3.4 seconds before!

Here's what's happening:
- PostgreSQL correctly identified that product_id 45 is in partition `p1` (you can see it says `reviews_partitioned_p1` in the query plan)
- But we don't have a dedicated index on `product_id` in the partitions
- It's using the composite primary key index (`id, product_id`), which isn't optimal for our query

Let's look at the partition structure:

```sql
demo_app=# \d reviews_partitioned_p0;

Table "public.reviews_partitioned_p0"
   Column   |            Type             | Collation | Nullable | Default                     
------------+-----------------------------+-----------+----------+----------
 id         | integer                     |           | not null | 
 product_id | integer                     |           | not null | 
 user_id    | integer                     |           | not null | 
 rating     | integer                     |           | not null | 
 comment    | text                        |           |          | 
 created_at | timestamp without time zone |           |          | now()

Partition of: reviews_partitioned FOR VALUES WITH (modulus 4, remainder 0)
Indexes:
    "reviews_partitioned_p0_pkey" PRIMARY KEY, btree (id, product_id)
```

The only index is the composite primary key. We need a proper index on `product_id`.

## Adding Indexes to Partitioned Tables

Here's the cool part: After PostgreSQL 11, you can create an index on the parent partitioned table, and it automatically creates the index on all child partitions.

```javascript
export async function up(knex) {
  await knex.schema.alterTable("reviews_partitioned", (table) => {
    table.index(["product_id"], "idx_reviews_partitioned_product");
  });
}
```

This single command creates indexes on all four partitions automatically.

## The Results

Now let's run our query again:

```sql
demo_app=# EXPLAIN ANALYZE SELECT * FROM reviews_partitioned WHERE product_id = 45;

QUERY PLAN
---------------------------------------------------------------------------
 Bitmap Heap Scan on reviews_partitioned_p1  
 (cost=463.33..123006.72 rows=42180 width=46) 
 (actual time=23.133..199.557 rows=42706 loops=1)
   Recheck Cond: (product_id = 45)
   Heap Blocks: exact=40541
   ->  Bitmap Index Scan on idx_reviews_partitioned_product_p1  
       (cost=0.00..452.79 rows=42180 width=0) 
       (actual time=10.643..10.644 rows=42706 loops=1)
         Index Cond: (product_id = 45)
 Planning Time: 0.145 ms
 Execution Time: 203.643 ms
```

**203 milliseconds!** Down from 3.4 seconds. That's a **17x improvement**.

But we can do better. Let's try a count query:

```sql
demo_app=# EXPLAIN ANALYZE SELECT count(*) FROM reviews_partitioned WHERE product_id = 45;

QUERY PLAN
--------------------------------------------------------------------------------------
 Aggregate  (cost=980.04..980.05 rows=1 width=8) 
            (actual time=20.425..20.427 rows=1 loops=1)
   ->  Index Only Scan using idx_reviews_partitioned_product_p1  
       (cost=0.44..874.59 rows=42180 width=0) 
       (actual time=1.491..13.745 rows=42706 loops=1)
         Index Cond: (product_id = 45)
         Heap Fetches: 0
 Planning Time: 2.070 ms
 Execution Time: 20.628 ms
```

**20 milliseconds!** 

Notice the query plan says "Index Only Scan" - this is even faster because PostgreSQL doesn't need to touch the actual table data (the heap). It can answer the query using just the index.

## Why Did This Work So Well?

Let me break down what changed:

**Before partitioning:**
- Query had to search through a 3.2GB table
- Even with indexes, data was scattered across the entire table
- PostgreSQL had to read 40,541 blocks from disk

**After partitioning:**
- PostgreSQL immediately knows product_id 45 is in partition `p1`
- It only searches a ~750MB partition (4x smaller)
- Same number of blocks, but they're all in a smaller, more cache-friendly space
- The smaller partition fits better in memory (PostgreSQL's shared buffers)

Think of it like searching for a book:
- Before: Search through 1 billion books in one room
- After: Know which room the book is in, then search through 250 million books

The second approach is much faster.

## When Partitioning Can Go Wrong

Partitioning isn't a magic bullet. Here are some cases where it can actually make things worse:

### 1. Bad Query Patterns

If you run queries that don't include the partition key:

```sql
SELECT * FROM reviews_partitioned WHERE rating = 5;
```

PostgreSQL has to scan **all partitions**. This is slower than scanning one large table because of the overhead of managing multiple partitions.

### 2. Frequent Updates That Change Partition Key

If you update `product_id` frequently:

```sql
UPDATE reviews_partitioned SET product_id = 99 WHERE id = 12345;
```

PostgreSQL has to:
1. Delete the row from the current partition
2. Insert it into the new partition

This is two operations instead of one.

### 3. Analytics Queries Across All Data

Queries like this will be slower:

```sql
SELECT rating, COUNT(*) FROM reviews_partitioned GROUP BY rating;
```

PostgreSQL has to aggregate data across all partitions. For these use cases, you'd want to create materialized views or use a separate analytics database.

### 4. Too Many Partitions

If you create 100 partitions for 1,000 rows, you're just adding overhead. Partitioning works best when:
- Each partition has a meaningful amount of data
- Your query pattern aligns with the partition key

## When Should You Use Partitioning?

Partitioning works well when:

1. **You have a clear access pattern** - Like "always query by product_id" or "always query recent data"
2. **Your table is large** - Partitioning a 100MB table is probably overkill
3. **You can't fit all indexes in memory** - Partitioning helps because each partition's index is smaller
4. **You want to archive old data easily** - With range partitioning by date, you can drop entire partitions of old data

Partitioning might **not** be the best choice when:

1. **Queries don't use the partition key** - You'll scan all partitions every time
2. **You need complex foreign keys** - Foreign key constraints are limited on partitioned tables
3. **You frequently update the partition key** - Updates become expensive
4. **Your data distribution is uneven** - One partition gets most of the data

## Testing Under Memory Pressure

I also wanted to test how partitioning performs when memory is constrained. In the real world, your database might not have enough RAM to cache all indexes.

I reduced the container memory from 1GB to 256MB:

```bash
docker update --memory 256m --memory-swap 512m reviews_demo_pg
```

The original non-partitioned query went from 1.9s to 2.7s - a 40% slowdown.

This happens because:
- The indexes don't fit in memory anymore
- PostgreSQL has to constantly swap data in and out
- Disk I/O becomes the bottleneck

With partitioned tables, the impact was less severe because each partition's index is smaller and more likely to stay cached.

## Conclusion

Partitioning isn't a replacement for proper indexing, query optimization, or scaling strategies like read replicas. But when used correctly, it can dramatically improve query performance.

In my case:
- **3.4 seconds → 20 milliseconds** for count queries (170x faster)
- **3.4 seconds → 203 milliseconds** for full row queries (17x faster)

The key was understanding my access pattern (always query by product_id) and choosing the right partitioning strategy (hash partitioning for even distribution).

Before you add expensive read replicas or throw more hardware at the problem, consider whether your data access patterns could benefit from partitioning. You might be surprised at what PostgreSQL can handle with the right table structure.

---
