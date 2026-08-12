from .database import engine, Base, SessionLocal

def seed_database():
    # Ensures all database tables are created cleanly
    Base.metadata.create_all(bind=engine)
    print("Database tables initialized successfully for production.")

if __name__ == "__main__":
    seed_database()
