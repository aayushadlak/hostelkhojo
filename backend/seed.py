from .database import engine, Base
from sqlalchemy import text

def seed_database() -> None:
    """
    Verify database schema and run automatic migrations for SQLite.
    """
    Base.metadata.create_all(bind=engine)
    
    # Automatic schema migration check for SQLite
    if engine.name == "sqlite":
        try:
            with engine.connect() as conn:
                # check hostels table
                res = conn.execute(text("PRAGMA table_info(hostels)"))
                cols = [row[1] for row in res.fetchall()]
                if "owner_id" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN owner_id VARCHAR"))
                
                # check property_submissions table
                res = conn.execute(text("PRAGMA table_info(property_submissions)"))
                cols = [row[1] for row in res.fetchall()]
                if "owner_id" not in cols:
                    conn.execute(text("ALTER TABLE property_submissions ADD COLUMN owner_id VARCHAR"))

                # check users table
                res = conn.execute(text("PRAGMA table_info(users)"))
                cols = [row[1] for row in res.fetchall()]
                if "role" not in cols:
                    conn.execute(text("ALTER TABLE users ADD COLUMN role VARCHAR DEFAULT 'student'"))
                
                conn.commit()
        except Exception as mig_err:
            print(f"Migration notice: {mig_err}")

    print("Database schema verified and ready.")

if __name__ == "__main__":
    seed_database()
