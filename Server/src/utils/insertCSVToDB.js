const insertCSVToDB = (csv, tableName) => {
    const data = CSVParser.parse(csv);

    data.forEach(async (entry) => {
        try {
            await Database.insert(tableName, entry);
        }
        catch (error) {
            console.error('Error inserting entry:', error);
        }
    });
}