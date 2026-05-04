# Backend Source Code

## Directory Structure

```
src/
├── db/              # Database initialization and migrations
├── jobs/            # Background scheduled tasks (reminders, cleanup)
├── middleware/       # Express/Hono middleware (auth, CSRF, rate limiting)
├── queue/           # Cron job scheduler
├── routes/          # API endpoint handlers
├── services/        # Business logic layer
│   └── notifications/  # Notification channel implementations (35+)
├── types/           # TypeScript type definitions
└── utils/           # Helper utilities (crypto, logging, etc.)
```

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Application entry point, server setup |
| `db/index.ts` | SQLite database initialization |
| `db/migrate.ts` | Database schema migrations |
| `jobs/tasks.ts` | Scheduled reminder checks |
| `queue/scheduler.ts` | Cron job configuration |

## Naming Conventions

- **Files**: kebab-case (`event.service.ts`, `auth.middleware.ts`)
- **Functions**: camelCase (`createEvent`, `getUserConfig`)
- **Interfaces**: PascalCase (`EventRow`, `UpdateEventData`)
- **Database columns**: snake_case (`user_id`, `created_at`)

## Adding New Features

1. Add route in `routes/` directory
2. Add business logic in `services/`
3. Add database migrations in `db/migrate.ts`
4. Update shared types in `shared/src/types/`
